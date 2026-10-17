const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

// ---------- 语音通话的 ICE 服务器（v0.4） ----------
// 默认只用公共 STUN。要加 TURN（跨国 / 严格 NAT 时需要），设置环境变量 ICE_SERVERS 为 JSON，例如：
// ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:你的服务器:3478","username":"u","credential":"p"}]
// 或直接改下面这个数组。
let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
if (process.env.ICE_SERVERS) {
  try { ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.error('ICE_SERVERS 不是有效的 JSON，已使用默认 STUN'); }
}
const ROOM_MAX = 6;          // 语音房最多人数
// 屏幕直播（v0.6）：每个直播最多几人同时观看。主播要给每位观众单独上传一路画面，人多了主播上行带宽吃不消。
const MAX_VIEWERS = Number(process.env.MAX_VIEWERS) || 5;
const RING_MS = 30000;       // 来电 30 秒没人接就自动结束

// ---------- 文件传输（v0.5） ----------
// 单个文件最大多少 MB。可用环境变量 MAX_FILE_MB 覆盖。注意 Cloudflare 免费隧道单个请求上限约 100MB。
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 50;
const MAX_FILE = MAX_FILE_MB * 1024 * 1024;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const fs = require('fs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// 只有这些图片会在聊天里显示缩略图；其他任何类型一律当作二进制下载（绝不内联显示 HTML / SVG）
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// ---------- 数据库（一个本地文件 data.db） ----------
const db = new DatabaseSync(path.join(__dirname, 'data.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT, hash TEXT, xp INTEGER DEFAULT 0, last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, user_id INTEGER, name TEXT, size INTEGER, mime TEXT, created INTEGER, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY, created_by INTEGER, created_at INTEGER, expires_at INTEGER, used_by INTEGER, used_at INTEGER);
`);
// 旧数据库升级：给用户表补上管理员标记
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
}
// v0.5 升级：消息可以带文件
if (!db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'file_id')) db.exec('ALTER TABLE messages ADD COLUMN file_id TEXT');
// v0.7 升级：回复、撤回、@提及；文件分类
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('messages', 'reply_to', 'INTEGER');
addCol('messages', 'recalled', 'INTEGER DEFAULT 0');
addCol('messages', 'recalled_by', 'INTEGER');
addCol('messages', 'mentions', 'TEXT');
addCol('files', 'kind', 'TEXT');
// v0.3 升级：个人资料（昵称、头像、颜色、签名）
for (const [col, def] of [['nick', 'TEXT'], ['avatar', 'TEXT'], ['color', 'TEXT'], ['bio', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
}

// ---------- 等级规则：升到第 N+1 级需要 20 * N² 经验 ----------
const XP_MESSAGE = 2;      // 发消息（每 5 秒最多算一次）
const XP_DAILY = 20;       // 每天首次登录
const level = xp => Math.floor(Math.sqrt(xp / 20)) + 1;
const profile = u => ({ name: u.name, nick: u.nick || u.name, avatar: u.avatar || '', color: u.color || '', bio: u.bio || '', level: level(u.xp) });
const info = u => { const L = level(u.xp); return { ...profile(u), xp: u.xp, from: 20 * (L - 1) ** 2, to: 20 * L ** 2, admin: !!u.is_admin }; };

// ---------- 个人资料校验：去掉控制字符，尖括号换成全角，杜绝 XSS ----------
const clean = (v, max) => [...String(v ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/</g, '＜').replace(/>/g, '＞').trim()].slice(0, max).join('');
const AVATAR_MAX = 200 * 1024;   // 上传头像最大约 200KB
const okAvatar = a => a === '' ||
  (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(a) && a.length <= AVATAR_MAX) ||
  (a.length <= 16 && [...a].length <= 4 && !/[\s<>"'&\\/]/.test(a));   // 表情或 1~2 个字

const today = () => new Date().toLocaleDateString('sv');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const userById = db.prepare('SELECT * FROM users WHERE id=?');
const userByName = db.prepare('SELECT * FROM users WHERE name=?');
const userByToken = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?');

function addXp(id, n) { db.prepare('UPDATE users SET xp=xp+? WHERE id=?').run(n, id); return userById.get(id); }
function dailyBonus(u) {
  if (u.last_login === today()) return;
  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(today(), u.id);
  addXp(u.id, XP_DAILY);
}
function newSession(id) {
  const t = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?)').run(t, id);
  return t;
}

// ---------- 账号接口 ----------
const app = express();
app.use(express.json({ limit: '400kb' }));

// ---------- v0.8：PWA（可安装成软件）----------
// 版本号只写在 package.json 里；首页和 service worker 里的 __APP_VERSION__ 会被替换成它。
// 升级后版本号变了，浏览器里的旧缓存会被自动替换，已打开的页面会提示“有新版本”。
const VERSION = require('./package.json').version;
const PUB = path.join(__dirname, 'public');
const withVersion = f => fs.readFileSync(path.join(PUB, f), 'utf8').split('__APP_VERSION__').join(VERSION);
const pages = { index: withVersion('index.html'), sw: withVersion('sw.js') };
const noCache = { 'Cache-Control': 'no-cache' };
app.get(['/', '/index.html'], (req, res) => res.set({ ...noCache, 'Content-Type': 'text/html; charset=utf-8' }).send(pages.index));
// service worker 必须放在根目录、不能被缓存，否则升级后新版本要很久才生效
app.get('/sw.js', (req, res) => res.set({ ...noCache, 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' }).send(pages.sw));
app.get('/manifest.webmanifest', (req, res) => res.set({ ...noCache, 'Content-Type': 'application/manifest+json; charset=utf-8' }).sendFile(path.join(PUB, 'manifest.webmanifest')));
// 离线页用它判断服务器是否恢复（不需要登录，只返回版本号）
app.get('/api/ping', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, v: VERSION }));
app.use(express.static(PUB));

// ---------- 防暴力尝试：同一来源 10 分钟内最多失败 10 次 ----------
const fails = new Map();
const who = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
const fresh = req => (fails.get(who(req)) || []).filter(t => Date.now() - t < 600000);
const limited = req => fresh(req).length >= 10;
const fail = req => fails.set(who(req), [...fresh(req), Date.now()]);

// ---------- 邀请码：管理员生成，随机，一次性，7 天有效 ----------
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉容易看混的字符
const INVITE_DAYS = 7;
const genCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const fmt = c => c.slice(0, 4) + '-' + c.slice(4);
const userOf = req => userByToken.get((req.headers.authorization || '').replace('Bearer ', ''));
const adminOf = req => { const u = userOf(req); return u && u.is_admin ? u : null; };

app.post('/api/invites', (req, res) => {
  const a = adminOf(req);
  if (!a) return res.status(403).json({ error: '只有管理员可以生成邀请码' });
  const code = genCode(), now = Date.now();
  db.prepare('INSERT INTO invites(code,created_by,created_at,expires_at) VALUES(?,?,?,?)').run(code, a.id, now, now + INVITE_DAYS * 864e5);
  res.json({ code: fmt(code) });
});

app.get('/api/invites', (req, res) => {
  if (!adminOf(req)) return res.status(403).json({ error: '无权限' });
  const rows = db.prepare('SELECT i.code, i.created_at, i.expires_at, i.used_by AS uid, u.name AS used_by FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created_at DESC LIMIT 50').all();
  res.json(rows.map(r => ({
    code: fmt(r.code), created_at: r.created_at, expires_at: r.expires_at, used_by: r.used_by,
    status: r.uid ? 'used' : r.expires_at < Date.now() ? 'expired' : 'unused',
    expired: !r.uid && r.expires_at < Date.now()
  })));
});

// 删除（作废）邀请码：只能删没被使用过的
app.delete('/api/invites/:code', (req, res) => {
  if (!adminOf(req)) return res.status(403).json({ error: '只有管理员可以删除邀请码' });
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(code);
  if (!inv) return res.status(404).json({ error: '邀请码不存在' });
  if (inv.used_by) return res.status(400).json({ error: '已被使用的邀请码不能删除' });
  db.prepare('DELETE FROM invites WHERE code=? AND used_by IS NULL').run(code);
  res.json({ ok: true });
});

// ---------- 个人资料 ----------
// ---------- 文件上传 / 下载 ----------
// 文件名清洗：只留最后一段，去掉路径符号、控制字符和 Windows 不允许的字符
function safeName(raw) {
  let n = String(raw || '');
  try { n = decodeURIComponent(n); } catch (_) {}
  n = n.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*\u200b-\u200f\u2028-\u202e]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  n = [...n].slice(0, 120).join('');
  return n || 'file';
}
// ---------- 文件分类与预览（v0.7） ----------
const EXT = n => ((String(n).match(/\.([A-Za-z0-9]+)$/) || [])[1] || '').toLowerCase();
const DOC_EXT = new Set('pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt md markdown csv tsv json log xml yml yaml ini conf toml epub pages numbers key'.split(' '));
const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg' };
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' };
// 纯文本预览：这些扩展名一律当作 text/plain 下发，浏览器只当字符显示（包括 html / svg 源码）
const TEXT_EXT = new Set('txt md markdown csv tsv json log xml yml yaml ini conf toml js mjs cjs ts tsx jsx py java c h cpp hpp cc cs go rs rb php sh bat ps1 sql css scss less html htm svg vue kt swift lua r m pl env gitignore'.split(' '));
const TEXT_MAX = 200 * 1024;
function kindOf(name) {
  const e = EXT(name);
  if (IMAGE_TYPES[e]) return 'image';
  if (AUDIO_TYPES[e] || VIDEO_TYPES[e]) return 'media';
  if (DOC_EXT.has(e)) return 'doc';
  return 'other';
}
function previewOf(name) {
  const e = EXT(name);
  if (IMAGE_TYPES[e]) return 'image';
  if (e === 'pdf') return 'pdf';
  if (VIDEO_TYPES[e]) return 'video';
  if (AUDIO_TYPES[e]) return 'audio';
  if (TEXT_EXT.has(e)) return 'text';
  return null;
}
for (const f of db.prepare('SELECT id, name FROM files WHERE kind IS NULL').all()) db.prepare('UPDATE files SET kind=? WHERE id=?').run(kindOf(f.name), f.id);
const fileMeta = f => f && { id: f.id, name: f.name, size: f.size, mime: f.mime, image: f.mime.startsWith('image/'), deleted: !!f.deleted, kind: f.kind || kindOf(f.name), preview: previewOf(f.name), created: f.created };
const fileById = db.prepare('SELECT * FROM files WHERE id=?');

// ---------- 消息输出（v0.7：带 id / 回复 / 撤回 / 提及） ----------
const MSG_SQL = 'SELECT m.id mid, m.text, m.ts, m.file_id, m.reply_to, m.recalled, m.recalled_by, m.mentions, u.* FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN files f ON f.id=m.file_id';
const msgRow = db.prepare(MSG_SQL + ' WHERE m.id=?');
const msgSel = where => db.prepare(MSG_SQL + ' WHERE ' + where);
const RECALL_MS = 2 * 60 * 1000;
function snippet(r) {
  if (!r) return null;
  const base = { id: r.mid, name: r.name, nick: r.nick || r.name };
  if (r.recalled) return { ...base, recalled: true, text: '' };
  if (r.file_id) { const f = fileById.get(r.file_id); return { ...base, text: '', file: f ? f.name : '文件' }; }
  return { ...base, text: [...r.text].slice(0, 80).join('') };
}
function msgOut(r) {
  const o = { id: r.mid, ...profile(r), text: r.text, ts: r.ts };
  if (r.recalled) {
    const by = r.recalled_by && r.recalled_by !== r.id ? userById.get(r.recalled_by) : null;
    return { ...o, text: '', recalled: true, recalledBy: by ? (by.nick || by.name) : null };
  }
  if (r.file_id) o.file = fileMeta(fileById.get(r.file_id)) || { id: r.file_id, name: '文件', size: 0, deleted: true };
  if (r.reply_to) o.reply = snippet(msgRow.get(r.reply_to)) || { id: r.reply_to, gone: true };
  if (r.mentions) { try { o.mentions = JSON.parse(r.mentions); } catch (_) {} }
  return o;
}

app.get('/api/config', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  res.json({ maxFile: MAX_FILE });
});

// 上传：请求体就是文件本身（application/octet-stream），文件名放在 X-File-Name 头里（URL 编码）
app.post('/api/files', (req, res) => {
  const u = userOf(req);
  if (!u) { req.resume(); return res.status(401).json({ error: '请先登录' }); }
  const len = Number(req.headers['content-length']);
  if (len > MAX_FILE) {
    // 稍微超一点就把剩下的读完再回 413，这样浏览器能看到中文错误；大太多就直接断开，不浪费流量
    if (len > MAX_FILE * 2) res.set('Connection', 'close'); else req.resume();
    return res.status(413).json({ error: '文件太大，最大 ' + MAX_FILE_MB + 'MB' });
  }
  const name = safeName(req.headers['x-file-name']);
  const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase();
  const mime = IMAGE_TYPES[ext] || 'application/octet-stream';
  const id = crypto.randomBytes(16).toString('hex');
  const tmp = path.join(UPLOAD_DIR, id + '.part');
  const out = fs.createWriteStream(tmp);
  let size = 0, done = false;
  const bail = (code, error) => {
    if (done) return; done = true;
    out.destroy(); fs.rm(tmp, { force: true }, () => {});
    req.unpipe(out); req.resume();
    if (!res.headersSent) res.status(code).json({ error });
  };
  req.on('data', c => {
    size += c.length;
    if (size > MAX_FILE) bail(413, '文件太大，最大 ' + MAX_FILE_MB + 'MB');
    if (size > MAX_FILE * 2) req.destroy();   // 没有 Content-Length 还一直发，就断开
  });
  req.on('aborted', () => bail(400, '上传被中断'));
  out.on('error', () => bail(500, '保存文件失败'));
  out.on('finish', () => {
    if (done) return; done = true;
    if (!size) { fs.rm(tmp, { force: true }, () => {}); return res.status(400).json({ error: '不能上传空文件' }); }
    fs.renameSync(tmp, path.join(UPLOAD_DIR, id));
    const ts = Date.now();
    db.prepare('INSERT INTO files(id,user_id,name,size,mime,created,kind) VALUES(?,?,?,?,?,?,?)').run(id, u.id, name, size, mime, ts, kindOf(name));
    const r = db.prepare('INSERT INTO messages(user_id,text,ts,file_id) VALUES(?,?,?,?)').run(u.id, '', ts, id);
    const f = fileMeta(fileById.get(id));
    io.emit('msg', msgOut(msgRow.get(Number(r.lastInsertRowid))));
    res.json(f);
  });
  req.pipe(out);
});

// 下载：必须登录；一律加 nosniff 和沙箱 CSP。只有白名单图片可以 inline，其余全部强制下载
app.get('/api/files/:id', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const id = String(req.params.id);
  const f = /^[a-f0-9]{32}$/.test(id) && fileById.get(id);
  if (!f || f.deleted) return res.status(404).json({ error: '文件不存在或已被删除' });
  const inline = f.mime.startsWith('image/') && !req.query.dl;
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({
    'Content-Type': f.mime,
    'Content-Length': f.size,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': (inline ? 'inline' : 'attachment') + `; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
  });
  fs.createReadStream(path.join(UPLOAD_DIR, f.id)).on('error', () => res.destroy()).pipe(res);
});

// 文件仓列表：分类 / 搜索 / 排序 / 分页
app.get('/api/files', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const q = req.query, where = ['f.deleted=0'], args = [];
  if (['image', 'doc', 'media', 'other'].includes(q.cat)) { where.push('f.kind=?'); args.push(q.cat); }
  if (q.q) { where.push("f.name LIKE ? ESCAPE '\\'"); args.push('%' + String(q.q).slice(0, 100).replace(/[\\%_]/g, c => '\\' + c) + '%'); }
  if (q.id) { where.push('f.id=?'); args.push(String(q.id)); }
  const order = (q.sort === 'size' ? 'f.size' : 'f.created') + (q.order === 'asc' ? ' ASC' : ' DESC');
  const limit = Math.min(Math.max(parseInt(q.limit) || 30, 1), 100), offset = Math.max(parseInt(q.offset) || 0, 0);
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM files f WHERE ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT f.*, u.name uname, u.nick unick FROM files f LEFT JOIN users u ON u.id=f.user_id WHERE ${w} ORDER BY ${order}, f.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const latest = db.prepare('SELECT MAX(created) t FROM files WHERE deleted=0').get().t || 0;
  res.json({ total, latest, items: rows.map(r => ({ ...fileMeta(r), uploader: { name: r.uname, nick: r.unick || r.uname } })) });
});

// 预览：必须登录（请求头带令牌，前端取回 blob 再显示，令牌不进网址）。
// 只有白名单类型才能预览；HTML/SVG 等只能作为纯文本看源码；PDF 先检查文件头。
app.get('/api/files/:id/preview', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const id = String(req.params.id);
  const f = /^[a-f0-9]{32}$/.test(id) && fileById.get(id);
  if (!f || f.deleted) return res.status(404).json({ error: '文件不存在或已被删除' });
  const kind = previewOf(f.name), e = EXT(f.name), file = path.join(UPLOAD_DIR, f.id);
  if (!kind) return res.status(415).json({ error: '这种文件不支持预览，请下载后查看' });
  const type = kind === 'image' ? IMAGE_TYPES[e] : kind === 'pdf' ? 'application/pdf' : kind === 'video' ? VIDEO_TYPES[e] : kind === 'audio' ? AUDIO_TYPES[e] : 'text/plain; charset=utf-8';
  if (kind === 'pdf') {
    const head = Buffer.alloc(5); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
    if (head.toString('latin1') !== '%PDF-') return res.status(415).json({ error: '这不是有效的 PDF 文件' });
  }
  const len = kind === 'text' ? Math.min(f.size, TEXT_MAX) : f.size;
  res.set({
    'Content-Type': type, 'Content-Length': len,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': 'attachment',
    'Cache-Control': 'private, no-store',
    'X-Preview-Kind': kind, 'X-Truncated': kind === 'text' && f.size > TEXT_MAX ? '1' : '0'
  });
  fs.createReadStream(file, { start: 0, end: len - 1 }).on('error', () => res.destroy()).pipe(res);
});

// 所有用户（@ 提及自动补全用）
app.get('/api/users', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(u => ({ name: u.name, nick: u.nick || u.name, avatar: u.avatar || '', color: u.color || '' })));
});

// 聊天记录：分页（before / after / around）与搜索
app.get('/api/messages', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const lim = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  let rows;
  if (req.query.around) {
    const a = parseInt(req.query.around) || 0, h = Math.floor(lim / 2);
    rows = [...msgSel('m.id<? ORDER BY m.id DESC LIMIT ?').all(a, h).reverse(), ...msgSel('m.id>=? ORDER BY m.id ASC LIMIT ?').all(a, lim - h)];
  } else if (req.query.after) rows = msgSel('m.id>? ORDER BY m.id ASC LIMIT ?').all(parseInt(req.query.after) || 0, lim);
  else rows = msgSel('m.id<? ORDER BY m.id DESC LIMIT ?').all(parseInt(req.query.before) || 2 ** 53, lim).reverse();
  res.json(rows.map(msgOut));
});
app.get('/api/messages/search', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json([]);
  const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const rows = db.prepare(`${MSG_SQL} WHERE m.recalled=0 AND (m.text LIKE ? ESCAPE '\\' OR f.name LIKE ? ESCAPE '\\') ORDER BY m.id DESC LIMIT 50`).all(like, like);
  res.json(rows.map(msgOut));
});

app.delete('/api/files/:id', (req, res) => {
  if (!adminOf(req)) return res.status(403).json({ error: '只有管理员可以删除文件' });
  const id = String(req.params.id);
  const f = /^[a-f0-9]{32}$/.test(id) && fileById.get(id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  db.prepare('UPDATE files SET deleted=1 WHERE id=?').run(id);
  fs.rm(path.join(UPLOAD_DIR, id), { force: true }, () => {});
  io.emit('file:deleted', { id });
  res.json({ ok: true });
});

app.get('/api/ice', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  res.json({ iceServers: ICE_SERVERS, roomMax: ROOM_MAX, maxViewers: MAX_VIEWERS });
});

app.get('/api/profile/:name', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const u = userByName.get(String(req.params.name));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json(profile(u));
});

app.put('/api/profile', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  const nick = clean(b.nick, 16), bio = clean(b.bio, 60);
  const color = String(b.color || '');
  const avatar = String(b.avatar ?? '').trim();
  if (!nick) return res.status(400).json({ error: '昵称不能为空' });
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: '颜色格式不对' });
  if (!okAvatar(avatar)) return res.status(400).json({ error: avatar.startsWith('data:') ? '头像图片太大（最大约 200KB）或格式不支持' : '头像只能是一个表情或 1~2 个字' });
  db.prepare('UPDATE users SET nick=?, bio=?, color=?, avatar=? WHERE id=?').run(nick, bio, color, avatar, u.id);
  const nu = userById.get(u.id);
  io.emit('profile', profile(nu));
  for (const [sid, uid] of onlineIds) if (uid === u.id) io.to(sid).emit('me', info(nu));
  pushOnline();
  res.json(profile(nu));
});

app.post('/api/register', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
  const name = String(req.body.name || '').trim();
  const pw = String(req.body.password || '');
  const code = String(req.body.invite || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (name.length < 2 || name.length > 16) return res.status(400).json({ error: '用户名需要 2 到 16 个字符' });
  if (pw.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (userByName.get(name)) return res.status(409).json({ error: '这个用户名已被使用，换一个试试' });
  const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;   // 全新系统的第一个账号自动成为管理员，不需要邀请码
  const salt = crypto.randomBytes(16).toString('hex');
  db.exec('BEGIN');
  try {
    if (!first) {
      const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(code);
      if (!inv || inv.used_by || inv.expires_at < Date.now()) {
        db.exec('ROLLBACK'); fail(req);
        return res.status(403).json({ error: '邀请码无效、已被使用或已过期' });
      }
    }
    const r = db.prepare('INSERT INTO users(name,salt,hash,is_admin) VALUES(?,?,?,?)').run(name, salt, hashPw(pw, salt), first ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    if (!first) db.prepare('UPDATE invites SET used_by=?, used_at=? WHERE code=?').run(id, Date.now(), code);
    db.exec('COMMIT');
    dailyBonus(userById.get(id));
    res.json({ token: newSession(id) });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: '注册失败，请重试' });
  }
});

app.post('/api/login', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
  const u = userByName.get(String(req.body.name || '').trim());
  const pw = String(req.body.password || '');
  const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) { fail(req); return res.status(401).json({ error: '用户名或密码不对' }); }
  dailyBonus(u);
  res.json({ token: newSession(u.id) });
});

// ---------- 实时聊天 ----------
const server = http.createServer(app);
const io = new Server(server);
const online = new Map();   // socket.id -> 用户名
const onlineIds = new Map();   // socket.id -> 用户 id
const lastXp = new Map();   // 用户 id -> 上次得经验的时间

io.use((socket, next) => {
  const u = userByToken.get(String(socket.handshake.auth.token || ''));
  if (!u) return next(new Error('auth'));
  socket.userId = u.id;
  next();
});

const pushOnline = () => io.emit('online', [...new Set(onlineIds.values())].map(id => profile(userById.get(id))));

// ---------- 语音信令：服务器只在已登录、且确实在同一通话/语音房里的人之间转发 ----------
const calls = new Map();   // 用户 id -> { peer: 对方 id, sock: 负责通话的 socket.id（被叫未接听时为 null）, state, timer }
const room = new Map();    // 用户 id -> socket.id
const socketsOf = uid => [...onlineIds].filter(([, id]) => id === uid).map(([sid]) => sid);
const busy = uid => calls.has(uid) || room.has(uid);
const toSide = (c, uid, ev, d) => (c.sock ? [c.sock] : socketsOf(uid)).forEach(sid => io.to(sid).emit(ev, d));
function endCall(uid, reason) {
  const c = calls.get(uid); if (!c) return;
  const p = calls.get(c.peer);
  clearTimeout(c.timer); calls.delete(uid); calls.delete(c.peer);
  toSide(c, uid, 'call:end', { reason });
  if (p) toSide(p, c.peer, 'call:end', { reason });
}
const pushRoom = () => io.emit('room', { max: ROOM_MAX, members: [...room.keys()].map(id => profile(userById.get(id))) });
function leaveRoom(uid, sid) {
  if (room.get(uid) !== sid) return;
  room.delete(uid);
  const name = userById.get(uid).name;
  for (const s of room.values()) io.to(s).emit('room:left', { name });
  pushRoom();
}

// ---------- 屏幕直播信令（v0.6）：一对多，主播给每位观众单独建一条只发送的连接 ----------
const lives = new Map();   // 主播 id -> { sock: 主播 socket.id, viewers: Map(观众 id -> socket.id) }
const liveList = () => [...lives.keys()].map(id => userById.get(id).name);
const pushLive = () => io.emit('live', liveList());
function endLive(uid) {
  const L = lives.get(uid); if (!L) return;
  lives.delete(uid);
  const name = userById.get(uid).name;
  for (const sid of L.viewers.values()) io.to(sid).emit('live:end', { name });
  pushLive();
}
function leaveLive(sid, vid, L) {
  if (L.viewers.get(vid) !== sid) return;
  L.viewers.delete(vid);
  io.to(L.sock).emit('live:viewer-left', { name: userById.get(vid).name });
  io.to(L.sock).emit('live:count', L.viewers.size);
}

io.on('connection', socket => {
  const me = userById.get(socket.userId);
  online.set(socket.id, me.name); onlineIds.set(socket.id, me.id);
  socket.emit('me', info(me));
  socket.emit('ver', VERSION);   // v0.8：页面版本和服务器不一致时，提示刷新

  // 断线重连：客户端带上最后收到的消息 id，只补发错过的消息；太多就整页重发
  const since = parseInt(socket.handshake.auth.since) || 0;
  const missed = since ? msgSel('m.id>? ORDER BY m.id ASC LIMIT 301').all(since) : null;
  if (missed && missed.length <= 300) {
    const recalledIds = db.prepare('SELECT id FROM messages WHERE recalled=1 AND id<=? AND id>?').all(since, since - 500).map(r => r.id);
    socket.emit('resync', { messages: missed.map(msgOut), recalled: recalledIds });
  } else {
    const rows = msgSel('1 ORDER BY m.id DESC LIMIT 50').all().reverse();
    socket.emit('history', rows.map(msgOut));
  }
  pushOnline();

  socket.on('msg', m => {
    const o = typeof m === 'string' ? { text: m } : (m && typeof m === 'object' ? m : {});
    const text = (typeof o.text === 'string' ? o.text : '').trim().slice(0, 500);   // 原样保存，前端只用 textContent 显示
    if (!text) return;
    const ts = Date.now();
    let reply = parseInt(o.reply) || null;
    if (reply && !db.prepare('SELECT 1 FROM messages WHERE id=?').get(reply)) reply = null;
    // @提及：只认真实存在的用户名
    const ments = [...new Set([...text.matchAll(/@([^\s@]{1,16})/g)].map(x => x[1]))].filter(n => userByName.get(n)).slice(0, 20);
    const r = db.prepare('INSERT INTO messages(user_id,text,ts,reply_to,mentions) VALUES(?,?,?,?,?)').run(socket.userId, text, ts, reply, ments.length ? JSON.stringify(ments) : null);
    let u = userById.get(socket.userId);
    if (ts - (lastXp.get(u.id) || 0) > 5000) {
      lastXp.set(u.id, ts);
      u = addXp(u.id, XP_MESSAGE);
      socket.emit('me', info(u));
    }
    io.emit('msg', msgOut(msgRow.get(Number(r.lastInsertRowid))));
  });

  // 撤回：自己 2 分钟内的消息，或者管理员撤回任何消息。文件消息撤回后文件也从文件仓删除
  socket.on('recall', id => {
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(parseInt(id) || 0);
    const u = userById.get(uid);
    const no = error => socket.emit('recall:error', { id, error });
    if (!row || row.recalled) return no('消息不存在或已撤回');
    if (!u.is_admin && (row.user_id !== uid || Date.now() - row.ts > RECALL_MS)) return no(row.user_id !== uid ? '只能撤回自己的消息' : '超过 2 分钟，不能撤回了');
    db.prepare("UPDATE messages SET recalled=1, recalled_by=?, text='', mentions=NULL WHERE id=?").run(uid, row.id);
    if (row.file_id) {
      db.prepare('UPDATE files SET deleted=1 WHERE id=?').run(row.file_id);
      fs.rm(path.join(UPLOAD_DIR, row.file_id), { force: true }, () => {});
      io.emit('file:deleted', { id: row.file_id });
    }
    io.emit('recall', msgOut(msgRow.get(row.id)));
  });

  // ----- 一对一通话 -----
  const uid = socket.userId;
  socket.emit('live', liveList());
  socket.emit('room', { max: ROOM_MAX, members: [...room.keys()].map(id => profile(userById.get(id))) });
  socket.on('call:invite', name => {
    const t = userByName.get(String(name || ''));
    const no = reason => socket.emit('call:end', { reason });
    if (!t || !socketsOf(t.id).length) return no('offline');
    if (t.id === uid) return no('self');
    if (busy(uid)) return no('selfbusy');
    if (busy(t.id)) return no('busy');
    const timer = setTimeout(() => endCall(uid, 'timeout'), RING_MS);
    calls.set(uid, { peer: t.id, sock: socket.id, state: 'ringing', timer });
    calls.set(t.id, { peer: uid, sock: null, state: 'ringing', timer });
    socket.emit('call:ringing', profile(t));
    socketsOf(t.id).forEach(sid => io.to(sid).emit('call:incoming', profile(userById.get(uid))));
  });
  socket.on('call:answer', ok => {
    const c = calls.get(uid);
    if (!c || c.state !== 'ringing' || c.sock) return;   // 只有还在响铃的被叫才能接
    if (!ok) return endCall(uid, 'declined');
    const p = calls.get(c.peer);
    clearTimeout(c.timer);
    c.sock = socket.id; c.state = p.state = 'active';
    socketsOf(uid).filter(s => s !== socket.id).forEach(s => io.to(s).emit('call:end', { reason: 'elsewhere' }));
    socket.emit('call:start', { ...profile(userById.get(c.peer)), caller: false });
    io.to(p.sock).emit('call:start', { ...profile(userById.get(uid)), caller: true });
  });
  socket.on('call:hangup', () => {
    const c = calls.get(uid);
    if (c && (c.sock === socket.id || !c.sock)) endCall(uid, c.sock ? 'hangup' : 'declined');
  });

  // ----- 语音房（多人，网状连接） -----
  socket.on('room:join', () => {
    if (room.has(uid)) return socket.emit('room:error', '你已经在语音房里了（可能在另一个窗口）');
    if (calls.has(uid)) return socket.emit('room:error', '请先挂断当前通话');
    if (room.size >= ROOM_MAX) return socket.emit('room:error', '语音房已满（最多 ' + ROOM_MAX + ' 人）');
    const peers = [...room.keys()].map(id => profile(userById.get(id)));
    for (const s of room.values()) io.to(s).emit('room:joined', profile(me));
    room.set(uid, socket.id);
    socket.emit('room:peers', peers);
    pushRoom();
  });
  socket.on('room:leave', () => leaveRoom(uid, socket.id));

  // ----- 屏幕直播 -----
  socket.on('live:start', () => {
    const L = lives.get(uid);
    if (L && L.sock !== socket.id) return socket.emit('live:error', { reason: 'elsewhere' });
    if (L) return;
    lives.set(uid, { sock: socket.id, viewers: new Map() });
    socket.emit('live:count', 0);
    pushLive();
  });
  socket.on('live:stop', () => { const L = lives.get(uid); if (L && L.sock === socket.id) endLive(uid); });
  socket.on('live:watch', name => {
    const t = userByName.get(String(name || ''));
    const L = t && lives.get(t.id);
    const no = reason => socket.emit('live:error', { name: String(name || ''), reason });
    if (!L) return no('notlive');
    if (t.id === uid) return no('self');
    const old = L.viewers.get(uid);
    if (!old && L.viewers.size >= MAX_VIEWERS) return no('full');
    if (old && old !== socket.id) io.to(old).emit('live:end', { name: t.name, reason: 'elsewhere' });   // 同一账号换了个窗口看
    L.viewers.set(uid, socket.id);
    io.to(L.sock).emit('live:viewer', profile(me));
    io.to(L.sock).emit('live:count', L.viewers.size);
  });
  socket.on('live:leave', name => {
    const t = userByName.get(String(name || ''));
    const L = t && lives.get(t.id);
    if (L) leaveLive(socket.id, uid, L);
  });

  // ----- WebRTC 信令转发（offer / answer / ice） -----
  socket.on('rtc', m => {
    if (!m || typeof m !== 'object' || typeof m.data !== 'object' || !m.data) return;
    if (JSON.stringify(m.data).length > 20000) return;
    const t = userByName.get(String(m.to || ''));
    if (!t) return;
    let dest = null;
    if (m.ch === 'call') {
      const c = calls.get(uid), p = calls.get(t.id);
      if (c && c.state === 'active' && c.sock === socket.id && c.peer === t.id && p) dest = p.sock;
    } else if (m.ch === 'room') {
      if (room.get(uid) === socket.id && room.has(t.id)) dest = room.get(t.id);
    }
    let ch = m.ch;
    if (m.ch === 'live') {
      // 主播 -> 观众：发给 'live-v'；观众 -> 主播：发给 'live-s'。其他任何组合一律丢弃
      const mine = lives.get(uid), theirs = lives.get(t.id);
      if (mine && mine.sock === socket.id && mine.viewers.has(t.id)) { dest = mine.viewers.get(t.id); ch = 'live-v'; }
      else if (theirs && theirs.viewers.get(uid) === socket.id) { dest = theirs.sock; ch = 'live-s'; }
    }
    if (dest) io.to(dest).emit('rtc', { from: me.name, ch, data: m.data });
  });

  socket.on('disconnect', () => {
    online.delete(socket.id); onlineIds.delete(socket.id); pushOnline();
    const c = calls.get(uid);
    if (c && (c.sock === socket.id || (!c.sock && !socketsOf(uid).length))) endCall(uid, c.state === 'active' ? 'hangup' : 'offline');
    leaveRoom(uid, socket.id);
    if (lives.get(uid)?.sock === socket.id) endLive(uid);
    for (const L of lives.values()) leaveLive(socket.id, uid, L);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Hush v' + VERSION + ' 已启动：http://localhost:' + PORT));
