// Hush v0.19：歌词（歌词字幕）
//  - parseLrc：解析 LRC（多时间戳、[offset:]、逐字时间 <mm:ss.xx>、同一时间两行 = 原文 + 翻译）
//  - readTags：从音频文件里读出歌名 / 歌手 / 专辑 / 内嵌歌词（ID3 USLT/SYLT、FLAC/Ogg 的 LYRICS、MP4 ©lyr、WAV 里的 ID3）
//  - decodeText：上传的 .lrc 可能是 UTF-8 / UTF-16 / GBK，自动识别
// 只用 Node 自带的模块，不需要额外安装。
'use strict';
const fs = require('fs');

const MAX_LYRIC = 200 * 1024;   // 一首歌的歌词最多 200KB 文本
const MAX_LINES = 3000;

// ---------- 文本编码 ----------
function decodeText(b) {
  if (!b || !b.length) return '';
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (_) {}
  try { return new TextDecoder('gb18030').decode(b); } catch (_) {}
  return b.toString('latin1');
}

// ID3 的“latin1”字段：先试 UTF-8，再试 GBK（必须完全合法），都不行才按 latin1
function legacy(b) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (_) {}
  if (b.some(x => x >= 0x80)) try { return new TextDecoder('gb18030', { fatal: true }).decode(b); } catch (_) {}
  return b.toString('latin1');
}

// ---------- LRC ----------
const TS = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META = /^\[(ti|ar|al|au|by|re|ve|length|offset|la|tool|id|#)\s*:([^\]]*)\]\s*$/i;
const cleanLine = s => s.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')     // 逐字时间
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
const frac = f => f == null || f === '' ? 0 : Number(f) / Math.pow(10, f.length);
// 返回 { synced, lines:[{t,x,tr?}], plain }。t 是秒（已加上 offset）。
function parseLrc(text) {
  text = String(text || '');
  if (text.length > MAX_LYRIC) text = text.slice(0, MAX_LYRIC);
  text = text.replace(/\r\n?/g, '\n');
  let offset = 0; const meta = {};
  const out = [];
  let stamped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const mm = META.exec(line);
    if (mm) { const k = mm[1].toLowerCase(), v = mm[2].trim(); meta[k] = v; if (k === 'offset' && /^[+-]?\d+$/.test(v)) offset = parseInt(v, 10) / 1000; continue; }
    if (/^\{.*\}$/.test(line)) continue;   // 网易云的 JSON 署名行
    TS.lastIndex = 0;
    const times = []; let m, end = 0;
    while ((m = TS.exec(line)) && m.index === end) { times.push(Number(m[1]) * 60 + Number(m[2]) + frac(m[3])); end = TS.lastIndex; }
    if (!times.length) { out.push({ t: null, x: cleanLine(line) }); continue; }
    const x = cleanLine(line.slice(end));
    for (const t of times) { out.push({ t, x }); stamped++; }
  }
  if (stamped >= 2 || (stamped >= 1 && out.every(l => l.t != null))) {
    // LRC 的 offset 是“歌词提前多少毫秒”：正数 = 歌词出现得更早
    const lines = out.filter(l => l.t != null).map(l => ({ t: Math.max(0, Math.round((l.t - offset) * 1000) / 1000), x: l.x }));
    lines.sort((a, b) => a.t - b.t);
    // 同一时间的两行：第二行当作翻译（很多中文 LRC 这样写）
    const merged = [];
    for (const l of lines) {
      const p = merged[merged.length - 1];
      if (p && Math.abs(p.t - l.t) < 0.005 && l.x && p.x && !p.tr) { p.tr = l.x; continue; }
      if (p && Math.abs(p.t - l.t) < 0.005 && !l.x) continue;
      merged.push(l);
    }
    const res = merged.slice(0, MAX_LINES);
    if (res.some(l => l.x)) return { synced: true, lines: res, plain: null, meta };
  }
  const plain = out.map(l => l.x).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return plain ? { synced: false, lines: [], plain, meta } : { synced: false, lines: [], plain: null, meta };
}
// 把翻译歌词（网易云的 tlyric）按时间合进原文
function mergeTrans(base, trans) {
  if (!base || !base.synced || !trans || !trans.synced) return base;
  const map = new Map(trans.lines.filter(l => l.x).map(l => [Math.round(l.t * 100), l.x]));
  for (const l of base.lines) {
    if (l.tr) continue;
    const k = Math.round(l.t * 100);
    const v = map.get(k) ?? map.get(k - 1) ?? map.get(k + 1);
    if (v && v !== l.x) l.tr = v;
  }
  return base;
}
// SYLT（ID3 里的同步歌词）转成 LRC 文本，方便统一存
const two = n => String(n).padStart(2, '0');
function toLrc(lines) {
  return lines.map(l => { const cs = Math.round(l.t * 100), m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60; return `[${two(m)}:${two(s)}.${two(cs % 100)}]${l.x}`; }).join('\n');
}

// ---------- 读文件 ----------
function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); }
const latin1 = (b, s, e) => b.toString('latin1', s, e);

// ---------- ID3v2 ----------
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const unsync = b => { const out = Buffer.alloc(b.length); let j = 0; for (let i = 0; i < b.length; i++) { out[j++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0x00) i++; } return out.subarray(0, j); };
function id3Str(enc, b) {
  if (!b.length) return '';
  let s;
  if (enc === 0) s = legacy(b);              // 规范上是 latin1，但国内很多文件其实写的是 GBK
  else if (enc === 1) s = b[0] === 0xfe && b[1] === 0xff ? new TextDecoder('utf-16be').decode(b.subarray(2)) : new TextDecoder('utf-16le').decode(b[0] === 0xff && b[1] === 0xfe ? b.subarray(2) : b);
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(b);
  else s = b.toString('utf8');
  return s.replace(/\u0000+$/g, '');
}
// 找字符串结尾（编码 1/2 是两个 0 字节）
function termAt(enc, b, from) {
  if (enc === 1 || enc === 2) { for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i; return b.length; }
  const i = b.indexOf(0, from); return i < 0 ? b.length : i;
}
function parseId3(tag, ver, out) {
  // tag：去掉 10 字节头之后的内容
  let p = 0;
  const v2 = ver === 2, idLen = v2 ? 3 : 4, hdLen = v2 ? 6 : 10;
  while (p + hdLen <= tag.length) {
    const id = latin1(tag, p, p + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let size = v2 ? (tag[p + 3] << 16) | (tag[p + 4] << 8) | tag[p + 5] : ver === 4 ? syncsafe(tag, p + 4) : tag.readUInt32BE(p + 4);
    const flags = v2 ? 0 : tag.readUInt16BE(p + 8);
    let body = tag.subarray(p + hdLen, p + hdLen + size);
    p += hdLen + size;
    if (size <= 0 || body.length < size) break;
    if (ver === 4) {
      if (flags & 0x0002) body = unsync(body);
      if (flags & 0x0001) body = body.subarray(4);   // 数据长度指示
      if (flags & 0x000c) continue;                  // 压缩 / 加密：不支持
    } else if (ver === 3 && (flags & 0x00c0)) continue;
    const enc = body[0];
    const key = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', ULT: 'USLT', SLT: 'SYLT' }[id] || id;
    if (key === 'TIT2' || key === 'TPE1' || key === 'TALB') {
      const s = id3Str(enc, body.subarray(1)).split('\u0000')[0].trim();
      const k = { TIT2: 'title', TPE1: 'artist', TALB: 'album' }[key];
      if (s && !out[k]) out[k] = s.slice(0, 200);
    } else if (key === 'USLT' && body.length > 4) {
      const d = termAt(enc, body, 4), start = d + (enc === 1 || enc === 2 ? 2 : 1);
      const s = id3Str(enc, body.subarray(start)).trim();
      if (s && (!out.lyrics || s.length > out.lyrics.length)) out.lyrics = s.slice(0, MAX_LYRIC);
    } else if (key === 'SYLT' && body.length > 6) {
      const fmt = body[4];   // 2 = 毫秒；1 = MPEG 帧（不支持）
      if (fmt !== 2) continue;
      let q = termAt(enc, body, 6) + (enc === 1 || enc === 2 ? 2 : 1);
      const lines = [];
      while (q < body.length && lines.length < MAX_LINES) {
        const e = termAt(enc, body, q); if (e + 4 + (enc === 1 || enc === 2 ? 2 : 1) > body.length) break;
        const s = id3Str(enc, body.subarray(q, e)).replace(/^[\r\n]+/, '');
        q = e + (enc === 1 || enc === 2 ? 2 : 1);
        const t = body.readUInt32BE(q); q += 4;
        lines.push({ t: t / 1000, x: s.replace(/\s+/g, ' ').trim() });
      }
      if (lines.length >= 2 && (!out.sylt || lines.length > out.sylt.length)) out.sylt = lines;
    }
  }
}
function readId3At(fd, pos, out) {
  const h = readAt(fd, pos, 10);
  if (h.length < 10 || latin1(h, 0, 3) !== 'ID3') return 0;
  const ver = h[3], flags = h[5], size = syncsafe(h, 6);
  if (ver < 2 || ver > 4 || size <= 0) return 10;
  let tag = readAt(fd, pos + 10, Math.min(size, 64 * 1024 * 1024));
  if (ver < 4 && (flags & 0x80)) tag = unsync(tag);
  if (ver >= 3 && (flags & 0x40)) {   // 扩展头
    const ext = ver === 4 ? syncsafe(tag, 0) : tag.readUInt32BE(0) + 4;
    tag = tag.subarray(ext);
  }
  try { parseId3(tag, ver, out); } catch (_) {}
  return 10 + size + (flags & 0x10 ? 10 : 0);
}

// ---------- Vorbis comment（FLAC / Ogg Vorbis / Opus） ----------
function parseVorbis(b, out) {
  let p = 0; if (b.length < 8) return;
  const vl = b.readUInt32LE(p); p += 4 + vl;
  if (p + 4 > b.length) return;
  const n = b.readUInt32LE(p); p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const l = b.readUInt32LE(p); p += 4;
    if (p + l > b.length) break;
    const s = b.toString('utf8', p, p + l); p += l;
    const eq = s.indexOf('='); if (eq < 1) continue;
    const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
    if (!v) continue;
    if (k === 'TITLE' && !out.title) out.title = v.slice(0, 200);
    else if (k === 'ARTIST' && !out.artist) out.artist = v.slice(0, 200);
    else if (k === 'ALBUM' && !out.album) out.album = v.slice(0, 200);
    else if (k === 'LYRICS' || k === 'SYNCEDLYRICS' || k === 'UNSYNCEDLYRICS' || k === 'UNSYNCED LYRICS' || k === 'LYRIC') {
      const prefer = k !== 'UNSYNCEDLYRICS' && k !== 'UNSYNCED LYRICS';
      if (!out.lyrics || (prefer && !out.lyricsPref) || (prefer === out.lyricsPref && v.length > out.lyrics.length)) { out.lyrics = v.slice(0, MAX_LYRIC); out.lyricsPref = prefer; }
    }
  }
}
function readFlac(fd, pos, out) {
  if (latin1(readAt(fd, pos, 4), 0, 4) !== 'fLaC') return;
  let p = pos + 4;
  for (let i = 0; i < 64; i++) {
    const h = readAt(fd, p, 4); if (h.length < 4) return;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) parseVorbis(readAt(fd, p + 4, Math.min(len, 16 * 1024 * 1024)), out);
    p += 4 + len;
    if (last) return;
  }
}
function readOgg(fd, out) {
  // 把前几个包拼出来：第 1 个是识别头，第 2 个是注释头（可能跨很多页，比如带了封面）
  let p = 0, pkt = [], pkts = 0, total = 0;
  for (let page = 0; page < 4096 && pkts < 2; page++) {
    const h = readAt(fd, p, 27); if (h.length < 27 || latin1(h, 0, 4) !== 'OggS') return;
    const ns = h[26], segs = readAt(fd, p + 27, ns);
    let q = p + 27 + ns;
    for (let i = 0; i < ns; i++) {
      const l = segs[i];
      if (pkts === 1) { pkt.push(readAt(fd, q, l)); total += l; if (total > 16 * 1024 * 1024) return; }
      q += l;
      if (l < 255) { if (pkts === 1) { pkts = 2; break; } pkts++; }
    }
    p = q;
  }
  const b = Buffer.concat(pkt);
  if (latin1(b, 0, 7) === '\x03vorbis') parseVorbis(b.subarray(7), out);
  else if (latin1(b, 0, 8) === 'OpusTags') parseVorbis(b.subarray(8), out);
}

// ---------- MP4 / M4A ----------
function readMp4(fd, size, out) {
  // 在顶层找 moov（可能在文件末尾），然后 moov > udta > meta > ilst
  let p = 0, moov = null;
  for (let i = 0; i < 512 && p + 8 <= size; i++) {
    const h = readAt(fd, p, 16); if (h.length < 8) break;
    let len = h.readUInt32BE(0); const typ = latin1(h, 4, 8);
    if (len === 1) len = Number(h.readBigUInt64BE(8)); else if (len === 0) len = size - p;
    if (len < 8) break;
    if (typ === 'moov') { if (len > 64 * 1024 * 1024) return; moov = readAt(fd, p, len); break; }
    p += len;
  }
  if (!moov) return;
  const kids = (b, s, e, cb) => { let q = s; while (q + 8 <= e) { let l = b.readUInt32BE(q); const t = latin1(b, q + 4, q + 8); let hd = 8; if (l === 1) { l = Number(b.readBigUInt64BE(q + 8)); hd = 16; } else if (l === 0) l = e - q; if (l < hd || q + l > e) break; cb(t, q + hd, q + l); q += l; } };
  const find = (b, s, e, t) => { let r = null; kids(b, s, e, (tt, a, z) => { if (!r && tt === t) r = [a, z]; }); return r; };
  const udta = find(moov, 8, moov.length, 'udta'); if (!udta) return;
  const meta = find(moov, udta[0], udta[1], 'meta'); if (!meta) return;
  // meta 是 full box：前 4 字节是版本 / 标志（有些文件没有，检查一下）
  let ms = meta[0]; if (latin1(moov, ms + 4, ms + 8) !== 'hdlr') ms += 4;
  const ilst = find(moov, ms, meta[1], 'ilst'); if (!ilst) return;
  kids(moov, ilst[0], ilst[1], (t, a, z) => {
    const d = find(moov, a, z, 'data'); if (!d || d[1] - d[0] < 8) return;
    const v = moov.toString('utf8', d[0] + 8, d[1]).trim(); if (!v) return;
    if (t === '\u00a9nam' && !out.title) out.title = v.slice(0, 200);
    else if (t === '\u00a9ART' && !out.artist) out.artist = v.slice(0, 200);
    else if (t === 'aART' && !out.artist) out.artist = v.slice(0, 200);
    else if (t === '\u00a9alb' && !out.album) out.album = v.slice(0, 200);
    else if (t === '\u00a9lyr' && !out.lyrics) out.lyrics = v.slice(0, MAX_LYRIC);
  });
}

// ---------- WAV ----------
function readWav(fd, size, out) {
  let p = 12;
  for (let i = 0; i < 256 && p + 8 <= size; i++) {
    const h = readAt(fd, p, 8); if (h.length < 8) return;
    const id = latin1(h, 0, 4), len = h.readUInt32LE(4);
    if (id === 'id3 ' || id === 'ID3 ') readId3At(fd, p + 8, out);
    else if (id === 'LIST' && len < 1024 * 1024) {
      const b = readAt(fd, p + 8, len);
      if (latin1(b, 0, 4) === 'INFO') { let q = 4; while (q + 8 <= b.length) { const k = latin1(b, q, q + 4), l = b.readUInt32LE(q + 4); const v = decodeText(b.subarray(q + 8, q + 8 + l)).replace(/\u0000+$/, '').trim(); if (k === 'INAM' && v && !out.title) out.title = v; if (k === 'IART' && v && !out.artist) out.artist = v; q += 8 + l + (l & 1); } }
    }
    p += 8 + len + (len & 1);
  }
}

// 返回 { title, artist, album, lyrics(文本，可能是 LRC), sylt(行) }，读不出来就是空对象
function readTags(file) {
  const out = {};
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, h = readAt(fd, 0, 12);
    let start = 0;
    if (latin1(h, 0, 3) === 'ID3') start = readId3At(fd, 0, out);
    const h2 = start ? readAt(fd, start, 12) : h;
    const sig = latin1(h2, 0, 4);
    if (sig === 'fLaC') readFlac(fd, start, out);
    else if (sig === 'OggS' && !start) readOgg(fd, out);
    else if (latin1(h, 4, 8) === 'ftyp' && !start) readMp4(fd, size, out);
    else if (sig === 'RIFF' && latin1(h2, 8, 12) === 'WAVE' && !start) readWav(fd, size, out);
  } catch (_) {} finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
  delete out.lyricsPref;
  return out;
}

// 内嵌歌词 → { raw(LRC 或纯文本), parsed }
function embedded(tags) {
  if (tags.sylt && tags.sylt.length >= 2) { const raw = toLrc(tags.sylt); return { raw, parsed: parseLrc(raw) }; }
  if (tags.lyrics) { const parsed = parseLrc(tags.lyrics); if (parsed.synced || parsed.plain) return { raw: tags.lyrics, parsed }; }
  return null;
}

// 从文件名 / 歌名里猜“歌手 - 歌名”
function guessArtistTitle(title) {
  const t = String(title || '').replace(/[_]+/g, ' ').replace(/\s*[\[(（【][^\])）】]*(?:live|伴奏|官方|mv|无损|高音质|320k|flac|hi-?res|remaster(?:ed)?)[^\])）】]*[\])）】]\s*/gi, ' ').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t) || /^(.+?)[-–—](.+)$/.exec(t);
  return m ? [{ artist: m[1].trim(), title: m[2].trim() }, { artist: m[2].trim(), title: m[1].trim() }] : [{ artist: '', title: t }];
}

module.exports = { parseLrc, mergeTrans, toLrc, readTags, embedded, decodeText, guessArtistTitle, MAX_LYRIC };
