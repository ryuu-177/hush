const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

// ---------- 语音通话 / 屏幕直播的 ICE 服务器（v0.4，v0.11.1 改为国内可用 STUN + Cloudflare TURN） ----------
// 默认 STUN：都已从外网实测能响应；stun.l.google.com 在国内连不上，已移除。
// 设置环境变量 ICE_SERVERS（JSON 数组）可整体替换这份 STUN / 静态 TURN 列表。
let ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
];
if (process.env.ICE_SERVERS) {
  try { ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.error('ICE_SERVERS 不是有效的 JSON，已使用默认 STUN'); }
}
// Cloudflare Realtime TURN（v0.11.1）：中转服务器，P2P 打不通时（比如国内两位好友之间）走它。
// 密钥只留在服务器：环境变量 CF_TURN_KEY_ID / CF_TURN_API_TOKEN，或者同目录 turn.json：{"keyId":"...","apiToken":"..."}
// turn.json 已在 .gitignore 里，不要发给别人。没配置就只用 STUN。
const TURN_BASE = (process.env.CF_TURN_BASE || 'https://rtc.live.cloudflare.com/v1').replace(/\/$/, '');
const TURN_TTL = Math.max(10, Number(process.env.CF_TURN_TTL) || 86400);   // 每份凭证有效期（秒）
const TURN_RETRY_MS = Number(process.env.CF_TURN_RETRY_MS) || 60000;      // 失败后多久再试
const turn = { cache: null, flight: null, failAt: 0, logged: false };
function turnConf() {
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) return { keyId: process.env.CF_TURN_KEY_ID, apiToken: process.env.CF_TURN_API_TOKEN };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'turn.json'), 'utf8'));
    if (j && j.keyId && j.apiToken) return { keyId: String(j.keyId).trim(), apiToken: String(j.apiToken).trim() };
  } catch (e) { if (e.code !== 'ENOENT' && !turn.badFile) { turn.badFile = true; console.error('turn.json 格式不对，应为 {"keyId":"...","apiToken":"..."}'); } }
  return null;
}
async function turnMint(c) {
  const r = await fetch(TURN_BASE + '/turn/keys/' + encodeURIComponent(c.keyId) + '/credentials/generate-ice-servers', {
    method: 'POST', headers: { Authorization: 'Bearer ' + c.apiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TURN_TTL }), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const list = (await r.json()).iceServers;
  // 只要带凭证的 TURN 部分；去掉 53 端口（官方说明浏览器会拦）
  const servers = (Array.isArray(list) ? list : []).filter(s => s && s.username && s.credential).map(s => ({
    urls: [].concat(s.urls || []).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u)), username: s.username, credential: s.credential,
  })).filter(s => s.urls.length);
  if (!servers.length) throw new Error('返回里没有 TURN 地址');
  const now = Date.now();
  return { servers, expires: now + TURN_TTL * 1000, refreshAt: now + TURN_TTL * 500 };   // 用到一半就换新的
}
function turnRefresh(c) {
  if (!turn.flight) turn.flight = turnMint(c).then(v => {
    if (turn.logged) console.log('Cloudflare TURN 已恢复');
    turn.cache = v; turn.logged = false; turn.failAt = 0; return v;
  }).catch(e => {
    turn.failAt = Date.now();
    if (!turn.logged) { turn.logged = true; console.error('Cloudflare TURN 凭证获取失败，暂时只用 STUN：' + e.message); }
    return null;
  }).finally(() => { turn.flight = null; });
  return turn.flight;
}
// 返回 { iceServers, exp }，exp = 距离这份凭证失效还有多少毫秒（只有 STUN 时为 null）
async function iceFor() {
  const c = turnConf(), now = Date.now();
  if (!c) return { iceServers: ICE_SERVERS, exp: null };
  let v = turn.cache && turn.cache.expires - now > Math.min(60000, TURN_TTL * 100) ? turn.cache : null;   // 快过期的不再发
  const due = !v || now >= v.refreshAt;
  if (due && now - turn.failAt >= TURN_RETRY_MS) {
    const p = turnRefresh(c);
    if (!v || v.expires - now < TURN_TTL * 250) v = (await p) || v;   // 旧凭证还很新鲜就后台换，不让用户等
  }
  if (!v) return { iceServers: ICE_SERVERS, exp: null };
  return { iceServers: ICE_SERVERS.concat(v.servers), exp: v.expires - now };
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
// v0.9 升级：个人背景、个人音乐仓库、群聊歌单、群聊设置（全部是新增的表 / 字段，旧数据不受影响）
addCol('users', 'bg', 'TEXT');
// v0.18：注册时间（老账号没有记录：用最早的消息 / 文件 / 歌曲时间估一个，标记为“约”）
addCol('users', 'created', 'INTEGER'); addCol('users', 'created_est', 'INTEGER DEFAULT 0');
addCol('messages', 'kind', 'TEXT');
// v0.17：图片尺寸（聊天里按比例占位）、内容哈希（表情包去重）、是否表情包（不进文件仓）
addCol('files', 'w', 'INTEGER'); addCol('files', 'h', 'INTEGER'); addCol('files', 'hash', 'TEXT'); addCol('files', 'sticker', 'INTEGER DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS files_hash ON files(hash)');
db.exec(`
CREATE TABLE IF NOT EXISTS music(id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, ext TEXT, mime TEXT, size INTEGER, dur REAL, created INTEGER);
CREATE TABLE IF NOT EXISTS playlist(qid INTEGER PRIMARY KEY, music_id TEXT, user_id INTEGER, k INTEGER, pin INTEGER DEFAULT 0, added INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
`);
// v0.10 升级：歌单里可以放网易云的歌（不占个人音乐仓库）。music_id 写成 'ne:<歌曲id>'，歌名等信息直接存在歌单里
for (const [c, d] of [['src', 'TEXT'], ['ntitle', 'TEXT'], ['nartist', 'TEXT'], ['ncover', 'TEXT'], ['ndur', 'REAL'], ['nvip', 'INTEGER DEFAULT 0']]) addCol('playlist', c, d);

// v0.21.3：已读回执。每人只记“读到第几条”（只增不减）；hide_read=1 的人不广播、也看不到别人的
db.exec('CREATE TABLE IF NOT EXISTS reads(user_id INTEGER PRIMARY KEY, last INTEGER NOT NULL DEFAULT 0, ts INTEGER)');
addCol('users', 'hide_read', 'INTEGER DEFAULT 0');

// ---------- 等级规则：升到第 N+1 级需要 20 * N² 经验 ----------
const XP_MESSAGE = 2;      // 发消息（每 5 秒最多算一次）
const XP_DAILY = 20;       // 每天首次登录
const level = xp => Math.floor(Math.sqrt(xp / 20)) + 1;
const profile = u => ({ name: u.name, nick: u.nick || u.name, avatar: u.avatar || '', color: u.color || '', bio: u.bio || '', bg: u.bg || '', level: level(u.xp) });
const info = u => { const L = level(u.xp); return { ...profile(u), xp: u.xp, from: 20 * (L - 1) ** 2, to: 20 * L ** 2, admin: !!u.is_admin, hideRead: !!u.hide_read }; };

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

// ---------- v0.18：只有 Hush 桌面版能聊天，网页只能登录 / 注册 / 看个人信息 ----------
// 桌面版（Electron）的 User-Agent 里自带 “Hush/版本号 … Electron/版本号”，1.1.x 不用更新就有。
// 聊天连接（socket.io）还要求页面在握手里带 client:'desktop'（只有桌面版的页面会带）。
// 这不是密码：懂技术的人可以伪造 User-Agent，这一点可以接受；仓库里也不放任何密钥。
// 临时恢复网页聊天（比如桌面版出问题时）：启动前设置环境变量 WEB_CHAT=1。
const WEB_CHAT = process.env.WEB_CHAT === '1';
const APP_UA = /\bHush\/\d+\.\d+\.\d+\b.*\bElectron\/\d+/;
const isApp = req => WEB_CHAT || APP_UA.test(String((req.headers && req.headers['user-agent']) || ''));
const DESK_ONLY = '网页版已不能聊天，请下载并使用 Hush 桌面版';
// 浏览器也能用的接口（登录、注册、个人信息、改资料 / 密码、邀请码、版本号）；其余 /api 一律只给桌面版
const WEB_OK = [['GET', /^\/ping$/], ['GET', /^\/desktop-version$/], ['POST', /^\/(register|login|logout|password)$/], ['GET', /^\/me$/], ['PUT', /^\/profile$/], ['*', /^\/invites(\/[^/]*)?$/]];
app.use('/api', (req, res, next) => {
  if (isApp(req) || WEB_OK.some(([m, r]) => (m === '*' || m === req.method || (m === 'GET' && req.method === 'HEAD')) && r.test(req.path))) return next();
  req.resume();
  res.status(403).set('Cache-Control', 'no-store').json({ error: DESK_ONLY, code: 'desktop-only' });
});
app.use(express.json({ limit: '400kb' }));   // 放在把关之后：被拒的请求连请求体都不解析

// ---------- v0.8：PWA（可安装成软件）----------
// 版本号只写在 package.json 里；首页和 service worker 里的 __APP_VERSION__ 会被替换成它。
// 升级后版本号变了，浏览器里的旧缓存会被自动替换，已打开的页面会提示“有新版本”。
const VERSION = require('./package.json').version;
const PUB = path.join(__dirname, 'public');
const withVersion = f => fs.readFileSync(path.join(PUB, f), 'utf8').split('__APP_VERSION__').join(VERSION);
const pages = { index: withVersion('index.html'), sw: withVersion('sw.js'), swOff: withVersion('sw-off.js') };
// 门户页的字体声明直接从 index.html 里复制，两边永远一致
pages.portal = withVersion('portal.html').replace('/*__FONTS__*/', (pages.index.match(/@font-face\s*\{[^}]*\}/g) || []).join('\n'));
const noCache = { 'Cache-Control': 'no-cache' };
// v0.18：桌面版打开首页 → 聊天程序；浏览器 → 账号门户（登录 / 注册 / 个人信息 / 下载桌面版）
app.get(['/', '/index.html'], (req, res) => res.set({ ...noCache, Vary: 'User-Agent', 'Content-Type': 'text/html; charset=utf-8' }).send(isApp(req) ? pages.index : pages.portal));
app.get('/portal.html', (req, res) => res.redirect(302, '/'));
// service worker 必须放在根目录、不能被缓存，否则升级后新版本要很久才生效
// v0.18：浏览器拿到的是“注销自己”的版本：清掉旧缓存、注销，不再弹通知、不再能安装成 PWA
app.get('/sw.js', (req, res) => res.set({ ...noCache, Vary: 'User-Agent', 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' }).send(isApp(req) ? pages.sw : pages.swOff));
app.get('/manifest.webmanifest', (req, res) => res.set({ ...noCache, 'Content-Type': 'application/manifest+json; charset=utf-8' }).sendFile(path.join(PUB, 'manifest.webmanifest')));
// 离线页用它判断服务器是否恢复（不需要登录，只返回版本号）
app.get('/api/ping', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, v: VERSION }));
// ---------- 桌面版更新（v0.16） ----------
// 在程序目录建 desktop 文件夹，放进安装包和 latest.json：{"version":"1.0.0","file":"Hush-Setup-1.0.0.exe","notes":"更新说明"}
// 桌面版启动时会来问 /api/desktop-version，有新版本就提示下载；网页版设置里也会出现“下载 Windows 桌面版”。
const DESK_DIR = path.join(__dirname, 'desktop');
const DESK_FILE = /^Hush-Setup-\d+\.\d+\.\d+\.exe$/;
function deskInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DESK_DIR, 'latest.json'), 'utf8'));
    const v = String(j.version || ''), f = path.basename(String(j.file || ''));
    if (!/^\d+\.\d+\.\d+$/.test(v)) return null;
    const ok = DESK_FILE.test(f) && fs.existsSync(path.join(DESK_DIR, f));
    return { version: v, url: ok ? '/desktop/' + f : null, notes: String(j.notes || '').slice(0, 1000) };
  } catch (_) { return null; }
}
app.get('/api/desktop-version', (req, res) => {
  const d = deskInfo(); res.set('Cache-Control', 'no-store');
  d ? res.json(d) : res.status(404).json({ error: '服务器上还没有放桌面版' });
});
// v0.17：桌面版 1.1.0 起用 electron-updater 在软件里自动更新，它会来取 latest.yml（版本号、文件名、sha512）和 .blockmap
const DESK_EXTRA = /^(latest\.yml|Hush-Setup-\d+\.\d+\.\d+\.exe\.blockmap)$/;
app.get('/desktop/:f', (req, res) => {
  const f = String(req.params.f || '');
  if (DESK_EXTRA.test(f)) {
    const p = path.join(DESK_DIR, f);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Type': f.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream' });
    return res.sendFile(p);
  }
  if (!DESK_FILE.test(f)) return res.status(404).end();
  const p = path.join(DESK_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.download(p, f);
});
// v0.19.1：桌面版 1.3.0 的桌面歌词小窗口是本地页面，要跨域用歌词字体（开源字体，公开的），这里允许跨域读取
app.use('/fonts/lyric', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
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
// v0.17：读图片文件头拿宽高（PNG / GIF / JPEG / WebP），读不出来就返回 null
function imageSize(b) {
  try {
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const t = b.toString('latin1', 12, 16);
      if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          let w = b.readUInt16BE(i + 7), h = b.readUInt16BE(i + 5);
          return { w, h, jpeg: true };
        }
        i += 2 + len;
      }
    }
  } catch (_) {}
  return null;
}
// JPEG 的 EXIF 方向 5–8 是旋转 90°，宽高要对调（浏览器显示时会按 EXIF 转正）
function jpegRotated(b) {
  try {
    let i = 2;
    while (i + 4 < b.length && b[i] === 0xff) {
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m === 0xe1 && b.toString('latin1', i + 4, i + 8) === 'Exif') {
        const t = i + 10, le = b.toString('latin1', t, t + 2) === 'II';
        const r16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), r32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
        const ifd = t + r32(t + 4), n = r16(ifd);
        for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (r16(e) === 0x0112) return r16(e + 8) >= 5; }
        return false;
      }
      if (m === 0xda) break;
      i += 2 + len;
    }
  } catch (_) {}
  return false;
}
function readHead(file, n = 256 * 1024) { try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return b.subarray(0, k); } catch (_) { return null; } }
function dimsOf(file) {
  const b = readHead(file); if (!b) return null;
  const d = imageSize(b); if (!d || !(d.w > 0 && d.h > 0)) return null;
  if (d.jpeg && jpegRotated(b)) return { w: d.h, h: d.w };
  return { w: d.w, h: d.h };
}
const setDims = db.prepare('UPDATE files SET w=?, h=? WHERE id=?');
const fileMeta = f => {
  if (!f) return f;
  const image = f.mime.startsWith('image/');
  if (image && !f.deleted && f.w == null) {   // 老图片：第一次用到时补上宽高（读不出来记 0，不再重复读）
    const d = dimsOf(path.join(UPLOAD_DIR, f.id)) || { w: 0, h: 0 };
    setDims.run(d.w, d.h, f.id); f.w = d.w; f.h = d.h;
  }
  const o = { id: f.id, name: f.name, size: f.size, mime: f.mime, image, deleted: !!f.deleted, kind: f.kind || kindOf(f.name), preview: previewOf(f.name), created: f.created };
  if (image && f.w > 0 && f.h > 0) { o.w = f.w; o.h = f.h; }
  if (f.sticker) o.sticker = true;
  return o;
};
const fileById = db.prepare('SELECT * FROM files WHERE id=?');

// ---------- 消息输出（v0.7：带 id / 回复 / 撤回 / 提及） ----------
const MSG_SQL = 'SELECT m.id mid, m.text, m.ts, m.kind mkind, m.file_id, m.reply_to, m.recalled, m.recalled_by, m.mentions, u.* FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN files f ON f.id=m.file_id';
const msgRow = db.prepare(MSG_SQL + ' WHERE m.id=?');
const msgSel = where => db.prepare(MSG_SQL + ' WHERE ' + where);
const RECALL_MS = 2 * 60 * 1000;
function snippet(r) {
  if (!r) return null;
  const base = { id: r.mid, name: r.name, nick: r.nick || r.name };
  if (r.recalled) return { ...base, recalled: true, text: '' };
  if (r.mkind === 'song') return { ...base, text: '点了《' + r.text + '》' };
  if (r.mkind === 'live') return { ...base, text: r.text === '1' ? '开始共享屏幕' : '结束了屏幕共享' };
  if (r.file_id) { const f = fileById.get(r.file_id); return { ...base, text: '', file: f ? f.name : '文件', image: !!(f && f.mime.startsWith('image/')), sticker: r.mkind === 'sticker' }; }
  return { ...base, text: [...r.text].slice(0, 80).join('') };
}
function msgOut(r) {
  const o = { id: r.mid, ...profile(r), text: r.text, ts: r.ts };
  if (r.recalled) {
    const by = r.recalled_by && r.recalled_by !== r.id ? userById.get(r.recalled_by) : null;
    return { ...o, text: '', recalled: true, recalledBy: by ? (by.nick || by.name) : null };
  }
  if (r.mkind === 'song') { o.song = { title: r.text }; return o; }   // v0.9：点歌系统行
  if (r.mkind === 'live') { o.text = ''; o.live = { on: r.text === '1' }; return o; }   // v0.11：共享屏幕系统行
  if (r.file_id) o.file = fileMeta(fileById.get(r.file_id)) || { id: r.file_id, name: '文件', size: 0, deleted: true };
  if (r.mkind === 'sticker') o.sticker = true;   // v0.17：表情包（不带气泡，小图）
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
  const sticker = req.headers['x-sticker'] === '1';   // v0.17：表情包
  if (sticker && (!IMAGE_TYPES[ext] || len > STICKER_MAX)) { req.resume(); return res.status(400).json({ error: '表情包只能是 10MB 以内的 png / jpg / gif / webp' }); }
  if (sticker && !stickerRate(u.id)) { req.resume(); return res.status(429).json({ error: '发得太快了，歇一下' }); }
  const hasher = crypto.createHash('sha256');
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
    size += c.length; hasher.update(c);
    if (sticker && size > STICKER_MAX) bail(413, '表情包最大 10MB');
    if (size > MAX_FILE) bail(413, '文件太大，最大 ' + MAX_FILE_MB + 'MB');
    if (size > MAX_FILE * 2) req.destroy();   // 没有 Content-Length 还一直发，就断开
  });
  req.on('aborted', () => bail(400, '上传被中断'));
  out.on('error', () => bail(500, '保存文件失败'));
  out.on('finish', () => {
    if (done) return; done = true;
    if (!size) { fs.rm(tmp, { force: true }, () => {}); return res.status(400).json({ error: '不能上传空文件' }); }
    const hash = hasher.digest('hex'), ts = Date.now();
    if (sticker) {   // 同一张表情服务器上只存一份
      const ex = stickerByHash.get(hash, size);
      if (ex) { fs.rm(tmp, { force: true }, () => {}); return res.json(sendSticker(u.id, ex.id)); }
    }
    fs.renameSync(tmp, path.join(UPLOAD_DIR, id));
    const d = mime.startsWith('image/') ? dimsOf(path.join(UPLOAD_DIR, id)) : null;
    if (sticker && !d) { fs.rm(path.join(UPLOAD_DIR, id), { force: true }, () => {}); return res.status(400).json({ error: '这不是有效的图片' }); }
    db.prepare('INSERT INTO files(id,user_id,name,size,mime,created,kind,w,h,hash,sticker) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, u.id, name, size, mime, ts, kindOf(name), d ? d.w : (mime.startsWith('image/') ? 0 : null), d ? d.h : (mime.startsWith('image/') ? 0 : null), hash, sticker ? 1 : 0);
    if (sticker) return res.json(sendSticker(u.id, id));
    const r = db.prepare('INSERT INTO messages(user_id,text,ts,file_id) VALUES(?,?,?,?)').run(u.id, '', ts, id);
    const f = fileMeta(fileById.get(id));
    io.emit('msg', msgOut(msgRow.get(Number(r.lastInsertRowid))));
    res.json(f);
  });
  req.pipe(out);
});

// ---------- 表情包（v0.17）：先按哈希问一下，服务器已经有这张就不用再传 ----------
const STICKER_MAX = 10 * 1024 * 1024;
const stickerByHash = db.prepare("SELECT id FROM files WHERE hash=? AND size=? AND deleted=0 AND mime LIKE 'image/%' ORDER BY sticker DESC, created LIMIT 1");
const stickerTimes = new Map();
function stickerRate(uid) {   // 每人 10 秒内最多 8 张
  const now = Date.now(), a = (stickerTimes.get(uid) || []).filter(t => now - t < 10000);
  if (a.length >= 8) { stickerTimes.set(uid, a); return false; }
  a.push(now); stickerTimes.set(uid, a); return true;
}
function sendSticker(uid, fid) {
  const r = db.prepare("INSERT INTO messages(user_id,text,ts,file_id,kind) VALUES(?,?,?,?,'sticker')").run(uid, '', Date.now(), fid);
  addXp(uid, 1);
  io.emit('msg', msgOut(msgRow.get(Number(r.lastInsertRowid))));
  return { ok: true, id: fid, reused: true };
}
app.post('/api/stickers/send', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const hash = String((req.body || {}).hash || ''), size = Number((req.body || {}).size) || 0;
  if (!/^[a-f0-9]{64}$/.test(hash) || !(size > 0 && size <= STICKER_MAX)) return res.status(400).json({ error: '参数不对' });
  const ex = stickerByHash.get(hash, size);
  if (!ex) return res.json({ need: true });
  if (!stickerRate(u.id)) return res.status(429).json({ error: '发得太快了，歇一下' });
  res.json(sendSticker(u.id, ex.id));
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
  const q = req.query, where = ['f.deleted=0', 'COALESCE(f.sticker,0)=0'], args = [];   // v0.17：表情包不进文件仓
  if (['image', 'doc', 'media', 'other'].includes(q.cat)) { where.push('f.kind=?'); args.push(q.cat); }
  if (q.q) { where.push("f.name LIKE ? ESCAPE '\\'"); args.push('%' + String(q.q).slice(0, 100).replace(/[\\%_]/g, c => '\\' + c) + '%'); }
  if (q.id) { where.push('f.id=?'); args.push(String(q.id)); }
  const order = (q.sort === 'size' ? 'f.size' : 'f.created') + (q.order === 'asc' ? ' ASC' : ' DESC');
  const limit = Math.min(Math.max(parseInt(q.limit) || 30, 1), 100), offset = Math.max(parseInt(q.offset) || 0, 0);
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM files f WHERE ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT f.*, u.name uname, u.nick unick FROM files f LEFT JOIN users u ON u.id=f.user_id WHERE ${w} ORDER BY ${order}, f.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const latest = db.prepare('SELECT MAX(created) t FROM files WHERE deleted=0 AND COALESCE(sticker,0)=0').get().t || 0;
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
  const rows = db.prepare(`${MSG_SQL} WHERE m.recalled=0 AND (m.kind IS NULL OR m.kind<>'live') AND (m.text LIKE ? ESCAPE '\\' OR f.name LIKE ? ESCAPE '\\') ORDER BY m.id DESC LIMIT 50`).all(like, like);
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

app.get('/api/ice', async (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });   // TURN 凭证只给已登录的人
  const { iceServers, exp } = await iceFor();
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers, exp, roomMax: ROOM_MAX, maxViewers: MAX_VIEWERS });
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

// =====================================================================
// v0.9：个人背景、个人音乐仓库、群聊歌单
// =====================================================================
const MUSIC_MAX_MB = Number(process.env.MUSIC_MAX_MB) || 100;   // 单首歌最大多少 MB（注意 Cloudflare 免费隧道单个请求上限约 100MB）
const MUSIC_MAX = MUSIC_MAX_MB * 1024 * 1024;
const MUSIC_DIR = path.join(UPLOAD_DIR, 'music'), BG_DIR = path.join(UPLOAD_DIR, 'bg');
fs.mkdirSync(MUSIC_DIR, { recursive: true }); fs.mkdirSync(BG_DIR, { recursive: true });
// 音乐仓库数量按等级：Lv.1~9 一首，Lv.10~19 两首，Lv.20 起三首（最多 3 首）
// v0.15：基础 5 首，每升 4 级多 1 首，最多 10 首（Lv.4 → 6 首 … Lv.20 起 10 首）
const MUSIC_BASE = 5, MUSIC_STEP = 4, MUSIC_CAP = 10;
const musicQuota = L => Math.min(MUSIC_CAP, MUSIC_BASE + Math.floor(Math.max(0, L) / MUSIC_STEP));
const nextUnlock = L => musicQuota(L) >= MUSIC_CAP ? null : (Math.floor(Math.max(0, L) / MUSIC_STEP) + 1) * MUSIC_STEP;
// 支持的音乐格式（扩展名 -> 类型 + 文件头家族）。wma / aiff 等主流浏览器播放不了，不收
const MUSIC_TYPES = {
  mp3: ['audio/mpeg', 'mpeg'], aac: ['audio/aac', 'mpeg'], flac: ['audio/flac', 'flac'], wav: ['audio/wav', 'wav'],
  m4a: ['audio/mp4', 'mp4'], mp4: ['audio/mp4', 'mp4'], ogg: ['audio/ogg', 'ogg'], oga: ['audio/ogg', 'ogg'], opus: ['audio/ogg', 'ogg'],
  webm: ['audio/webm', 'webm'], weba: ['audio/webm', 'webm']
};
// 看文件头确认真的是音频（防止把别的文件改个扩展名传上来）
function sniffAudio(b) {
  const s = (o, t) => b.length >= o + t.length && b.toString('latin1', o, o + t.length) === t;
  if (s(0, 'fLaC')) return 'flac';
  if (s(0, 'ID3')) return 'id3';
  if (s(0, 'RIFF') && s(8, 'WAVE')) return 'wav';
  if (s(0, 'OggS')) return 'ogg';
  if (s(4, 'ftyp')) return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mpeg';
  return null;
}
const headOf = (file, n = 64, at = 0) => { const b = Buffer.alloc(n); const fd = fs.openSync(file, 'r'); const r = fs.readSync(fd, b, 0, n, at); fs.closeSync(fd); return b.subarray(0, r); };
// 文件开头是 ID3 标签时，跳过标签再看真正的音频头（mp3 / flac 都可能带 ID3）
function audioFamily(file) {
  const h = headOf(file), f = sniffAudio(h);
  if (f !== 'id3' || h.length < 10) return f;
  const size = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
  const body = headOf(file, 4096, 10 + size + (h[5] & 0x10 ? 10 : 0));
  if (body.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  for (let i = 0; i + 1 < body.length; i++) if (body[i] === 0xff && (body[i + 1] & 0xe0) === 0xe0) return 'mpeg';
  return null;
}
const musicById = db.prepare('SELECT * FROM music WHERE id=?');
const musicOut = m => ({ id: m.id, title: m.title, artist: m.artist || '', dur: m.dur, size: m.size, ext: m.ext, created: m.created, lyr: lySrc(m.id), queued: !!db.prepare('SELECT 1 FROM playlist WHERE music_id=?').get(m.id) });
const okHex = id => /^[a-f0-9]{32}$/.test(String(id));
const lySrc = k => { const r = db.prepare('SELECT src FROM lyrics WHERE k=?').get(k); return r ? r.src : null; };   // v0.19：歌词来源（lrc / tag / lrclib / none）

// ----- 设置（群聊设置 + 签名密钥），存在 settings 表 -----
const getSet = (k, d) => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? r.v : d; };
const setSet = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
if (!getSet('sign_secret')) setSet('sign_secret', crypto.randomBytes(32).toString('hex'));
const SIGN_SECRET = getSet('sign_secret');
const MAX_PER = 5;   // 每人同时点歌的上限（v0.21.3 从 3 提到 5）
// v0.21.3：默认改成每人 5 首。只有从来没存过这个值时才写 5，管理员手动改过（包括改小）的一律不动。
if (getSet('music_per') == null) setSet('music_per', '5');
const groupSettings = () => ({ music: getSet('music_on', '0') === '1', skip: getSet('music_skip', '0') === '1', per: Math.min(MAX_PER, Math.max(1, parseInt(getSet('music_per', '5')) || 5)) });

// ----- 播放地址：<audio> 不能带请求头，所以给一个有时效的签名网址（不是登录令牌） -----
const sign = (id, uid, exp) => crypto.createHmac('sha256', SIGN_SECRET).update(id + '.' + uid + '.' + exp).digest('base64url');
const urlTtl = dur => Math.min(3 * 3600e3, Math.max(15 * 60e3, (dur || 0) * 1000 + 15 * 60e3));
// 按 Range 请求分段发送（拖进度条、flac 都需要），返回 206
function sendRange(req, res, file, size, type) {
  res.set({ 'Accept-Ranges': 'bytes', 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
  const range = req.headers.range, m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) return res.status(416).set('Content-Range', 'bytes */' + size).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.set('Content-Length', size);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ----- 个人背景图：浏览器里裁剪压缩后直接上传图片本身 -----
const BG_MAX = 2 * 1024 * 1024;
const imgKind = b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : b.toString('hex', 0, 8) === '89504e470d0a1a0a' ? 'png' : null;
const BG_TYPES = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
const okBg = v => /^[a-f0-9]{32}\.(jpg|webp|png)$/.test(String(v));
function setBg(u, val) {
  const old = u.bg;
  db.prepare('UPDATE users SET bg=? WHERE id=?').run(val, u.id);
  if (old && okBg(old) && old !== val) try { fs.rmSync(path.join(BG_DIR, old), { force: true }); } catch (_) {}
  const nu = userById.get(u.id);
  io.emit('profile', profile(nu));
  for (const [sid, uid] of onlineIds) if (uid === u.id) io.to(sid).emit('me', info(nu));
  pushOnline();
  return profile(nu);
}
app.put('/api/profile/bg', (req, res) => {
  const u = userOf(req);
  if (!u) { req.resume(); return res.status(401).json({ error: '请先登录' }); }
  const len = Number(req.headers['content-length']);
  if (len > BG_MAX) { if (len > BG_MAX * 2) res.set('Connection', 'close'); else req.resume(); return res.status(413).json({ error: '背景图太大（最大 2MB）' }); }
  const chunks = []; let size = 0, over = false;
  req.on('data', c => { size += c.length; if (size > BG_MAX) { if (!over) { over = true; res.status(413).json({ error: '背景图太大（最大 2MB）' }); } req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (over) return;
    const b = Buffer.concat(chunks), k = imgKind(b);
    if (!k) return res.status(415).json({ error: '背景只能是 JPG / PNG / WebP 图片' });
    const name = crypto.randomBytes(16).toString('hex') + '.' + k;
    fs.writeFileSync(path.join(BG_DIR, name), b);
    res.json(setBg(userById.get(u.id), name));
  });
});
app.delete('/api/profile/bg', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  res.json(setBg(u, null));
});
app.get('/api/bg/:name', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const n = String(req.params.name);
  if (!okBg(n) || !db.prepare('SELECT 1 FROM users WHERE bg=?').get(n)) return res.status(404).json({ error: '背景不存在' });
  res.set({ 'Content-Type': BG_TYPES[n.split('.').pop()], 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable' });
  fs.createReadStream(path.join(BG_DIR, n)).on('error', () => res.destroy()).pipe(res);
});

// ----- 个人音乐仓库 -----
function myMusic(u) {
  const L = level(u.xp), items = db.prepare('SELECT * FROM music WHERE user_id=? ORDER BY created').all(u.id).map(musicOut);
  return { items, used: items.length, quota: musicQuota(L), cap: MUSIC_CAP, level: L, next: nextUnlock(L), maxMb: MUSIC_MAX_MB };
}
app.get('/api/music', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  res.json(myMusic(u));
});
// 上传：请求体就是音频文件，文件名放在 X-File-Name，时长（秒，浏览器读出来的）放在 X-Duration，歌名放在 X-Title
app.post('/api/music', (req, res) => {
  const u = userOf(req);
  if (!u) { req.resume(); return res.status(401).json({ error: '请先登录' }); }
  const no = (code, error) => { if (Number(req.headers['content-length']) > MUSIC_MAX * 2) res.set('Connection', 'close'); else req.resume(); res.status(code).json({ error }); };
  const L = level(u.xp), used = db.prepare('SELECT COUNT(*) n FROM music WHERE user_id=?').get(u.id).n;
  if (used >= musicQuota(L)) return no(403, nextUnlock(L) ? `音乐仓库已满（${used}/${musicQuota(L)}），Lv.${nextUnlock(L)} 解锁第 ${musicQuota(L) + 1} 首` : `音乐仓库已满（最多 ${MUSIC_CAP} 首）`);
  if (Number(req.headers['content-length']) > MUSIC_MAX) return no(413, '文件太大，单首最大 ' + MUSIC_MAX_MB + 'MB');
  const name = safeName(req.headers['x-file-name']), ext = EXT(name), t = MUSIC_TYPES[ext];
  if (!t) return no(415, '不支持这种格式，请上传 mp3 / flac / wav / m4a / aac / ogg / opus');
  const dur = Number(req.headers['x-duration']);
  if (!(dur > 0.5 && dur <= 4 * 3600)) return no(400, '读不出这首歌的时长，可能文件已损坏');
  let title = ''; try { title = decodeURIComponent(String(req.headers['x-title'] || '')); } catch (_) {}
  title = clean(title, 60) || clean(name.replace(/\.[^.]+$/, ''), 60) || '未命名';
  const id = crypto.randomBytes(16).toString('hex'), tmp = path.join(MUSIC_DIR, id + '.part');
  const out = fs.createWriteStream(tmp);
  let size = 0, done = false;
  const bail = (code, error) => {
    if (done) return; done = true;
    out.destroy(); fs.rm(tmp, { force: true }, () => {});
    req.unpipe(out); req.resume();
    if (!res.headersSent) res.status(code).json({ error });
  };
  req.on('data', c => { size += c.length; if (size > MUSIC_MAX) bail(413, '文件太大，单首最大 ' + MUSIC_MAX_MB + 'MB'); if (size > MUSIC_MAX * 2) req.destroy(); });
  req.on('aborted', () => bail(400, '上传被中断'));
  out.on('error', () => bail(500, '保存文件失败'));
  out.on('finish', () => {
    if (done) return; done = true;
    const okFam = size > 0 && audioFamily(tmp) === t[1];
    if (!okFam) { fs.rm(tmp, { force: true }, () => {}); return res.status(415).json({ error: size ? '这不是有效的音频文件' : '不能上传空文件' }); }
    const nu = userById.get(u.id), n2 = db.prepare('SELECT COUNT(*) n FROM music WHERE user_id=?').get(u.id).n;
    if (n2 >= musicQuota(level(nu.xp))) { fs.rm(tmp, { force: true }, () => {}); return res.status(403).json({ error: '音乐仓库已满' }); }   // 同时传了好几首
    fs.renameSync(tmp, path.join(MUSIC_DIR, id));
    db.prepare('INSERT INTO music(id,user_id,title,ext,mime,size,dur,created) VALUES(?,?,?,?,?,?,?,?)').run(id, u.id, title, ext, t[0], size, Math.round(dur * 1000) / 1000, Date.now());
    try { scanTags(id); } catch (_) {}   // v0.19：读出歌手 / 专辑 / 内嵌歌词
    res.json({ ...musicOut(musicById.get(id)), library: myMusic(nu) });
  });
  req.pipe(out);
});
app.patch('/api/music/:id', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const m = okHex(req.params.id) && musicById.get(String(req.params.id));
  if (!m || m.user_id !== u.id) return res.status(404).json({ error: '歌曲不存在' });
  const title = clean((req.body || {}).title, 60);
  if (!title) return res.status(400).json({ error: '歌名不能为空' });
  db.prepare('UPDATE music SET title=? WHERE id=?').run(title, m.id);
  if (db.prepare('SELECT 1 FROM playlist WHERE music_id=?').get(m.id)) pushMusic();
  res.json(musicOut(musicById.get(m.id)));
});
app.delete('/api/music/:id', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const m = okHex(req.params.id) && musicById.get(String(req.params.id));
  if (!m || (m.user_id !== u.id && !u.is_admin)) return res.status(404).json({ error: '歌曲不存在' });
  plDropMusic(m.id);
  db.prepare('DELETE FROM music WHERE id=?').run(m.id);
  db.prepare('DELETE FROM lyrics WHERE k=?').run(m.id);
  try { fs.rmSync(path.join(MUSIC_DIR, m.id), { force: true }); } catch (_) {}
  res.json({ ok: true, library: myMusic(userById.get(u.id)) });
});
// 取播放地址：自己的歌、或者已经在群聊歌单里的歌
app.get('/api/music/:id/url', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const m = okHex(req.params.id) && musicById.get(String(req.params.id));
  if (!m || (m.user_id !== u.id && !u.is_admin && !db.prepare('SELECT 1 FROM playlist WHERE music_id=?').get(m.id))) return res.status(404).json({ error: '歌曲不存在' });
  const exp = Date.now() + urlTtl(m.dur);
  res.set('Cache-Control', 'no-store').json({ url: `/api/music/${m.id}/stream?u=${u.id}&e=${exp}&s=${sign(m.id, u.id, exp)}`, exp });
});
app.get('/api/music/:id/stream', (req, res) => {
  const id = String(req.params.id), uid = parseInt(req.query.u), exp = parseInt(req.query.e), s = String(req.query.s || '');
  if (!okHex(id) || !uid || !exp || !s) return res.status(401).json({ error: '链接无效' });
  const want = Buffer.from(sign(id, uid, exp)), got = Buffer.from(s);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return res.status(403).json({ error: '链接无效' });
  if (exp < Date.now()) return res.status(403).json({ error: '链接已过期' });
  const m = musicById.get(id);
  if (!m || !userById.get(uid)) return res.status(404).json({ error: '歌曲不存在' });
  sendRange(req, res, path.join(MUSIC_DIR, m.id), m.size, m.mime);
});

// ----- 群聊设置（管理员） -----
app.get('/api/group', (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  res.json(groupSettings());
});
app.put('/api/group', (req, res) => {
  if (!adminOf(req)) return res.status(403).json({ error: '只有管理员可以修改群聊设置' });
  const b = req.body || {};
  if (typeof b.music === 'boolean') setSet('music_on', b.music ? 1 : 0);
  if (typeof b.skip === 'boolean') setSet('music_skip', b.skip ? 1 : 0);
  if (Number.isInteger(b.per) && b.per >= 1 && b.per <= MAX_PER) setSet('music_per', b.per);
  if (groupSettings().music) plStart(); else plStop();
  pushMusic();
  res.json(groupSettings());
});

// ----- 群聊歌单：服务器说了算（队列、当前歌曲、开始时间），所有人按服务器时间同步播放 -----
// 公平轮流：每首歌有一个“轮次” k，同一轮里按点歌先后；同一个人的第二首自动排到下一轮。
const LEAD = 1200;    // 切歌后留 1.2 秒给大家缓冲
const GRACE = 600;
const PL = { cur: null, lastKey: new Map(), curKey: 0 };   // cur: { qid, startedAt, timer }
const plRows = () => db.prepare("SELECT p.*, COALESCE(m.title, p.ntitle) title, COALESCE(m.dur, p.ndur) dur, m.artist martist, u.name uname, u.nick unick FROM playlist p LEFT JOIN music m ON m.id=p.music_id JOIN users u ON u.id=p.user_id WHERE m.id IS NOT NULL OR p.src='netease' ORDER BY p.pin DESC, p.k, p.qid").all();
const plItem = r => {
  const o = { qid: r.qid, id: r.music_id, title: r.title, dur: r.dur, by: { name: r.uname, nick: r.unick || r.uname } };
  if (r.martist) o.artist = r.martist;
  if (r.src === 'netease') { const nid = r.music_id.slice(3); Object.assign(o, { src: 'netease', nid, artist: r.nartist || '', cover: r.ncover || '', url: NE_MEDIA.replace('{id}', nid) }); if (r.nvip) o.vip = true; }
  return o;
};
function musicState() {
  const rows = plRows(), g = groupSettings();
  const cur = PL.cur && rows.find(r => r.qid === PL.cur.qid);
  return { ...g, now: Date.now(), current: cur ? { ...plItem(cur), startedAt: PL.cur.startedAt, paused: !!PL.cur.paused, pos: PL.cur.paused ? PL.cur.pos : null } : null, queue: rows.filter(r => !cur || r.qid !== cur.qid).map(plItem) };
}
const pushMusic = () => io.emit('music', musicState());
function plStart() {
  if (PL.cur || !groupSettings().music) return;
  const r = plRows()[0]; if (!r) return;
  db.prepare('UPDATE playlist SET pin=1 WHERE qid=?').run(r.qid);
  const startedAt = Date.now() + LEAD;
  PL.cur = { qid: r.qid, startedAt, timer: setTimeout(() => { plNext(r.qid); }, r.dur * 1000 + LEAD + GRACE) };
  if (r.src === 'netease') {
    // 网易云的歌可能因为地区 / 版权 / VIP 放不了：有人在加载、但过了 NE_WAIT 还没有任何人加载成功，就自动跳过
    PL.cur.ne = { ok: false, oks: new Set(), tries: new Set(), fails: new Set(), fail: null };
    PL.cur.watch = setTimeout(() => { const c = PL.cur; if (c && c.qid === r.qid && c.ne && !c.ne.ok && c.ne.tries.size) neSkip(r.qid, 'timeout'); }, LEAD + NE_WAIT);   // 超时：谁都没加载成功
  }
}
// ----- v0.11：暂停 / 继续 / 拖进度（点歌的人和管理员可以操作，服务器说了算，所有人同步） -----
// 播放中：位置 = (现在 - startedAt) / 1000；暂停时：位置固定在 pos，自动下一首的计时器停掉，继续时重新算。
const CTL_LEAD = 350;   // 操作后留一点时间给大家同时跟上
function plArm(c, dur) {   // 按当前 startedAt 重新设置“播完自动下一首”
  clearTimeout(c.timer);
  c.timer = setTimeout(() => { plNext(c.qid); }, Math.max(0, c.startedAt + dur * 1000 - Date.now()) + GRACE);
}
function plCtl(u, qid, op, t) {
  const c = PL.cur, row = c && plRows().find(r => r.qid === c.qid);
  if (!c || !row || (qid && parseInt(qid) !== c.qid)) return '这首歌已经播完了';
  if (!u.is_admin && row.user_id !== u.id) return '只有点歌的人和管理员可以控制播放';
  const now = Date.now(), dur = row.dur, cur = c.paused ? c.pos : Math.min(dur, Math.max(0, (now - c.startedAt) / 1000));
  if (op === 'seek') {
    t = Number(t); if (!isFinite(t)) return '位置不对';
    t = Math.min(Math.max(0, dur - 0.5), Math.max(0, t));
  } else t = cur;
  if (op === 'pause' || (op === 'seek' && c.paused)) { clearTimeout(c.timer); c.paused = true; c.pos = Math.round(t * 1000) / 1000; c.startedAt = now - t * 1000; }
  else if (op === 'play' || op === 'seek') { c.paused = false; c.pos = null; c.startedAt = now + CTL_LEAD - t * 1000; plArm(c, dur); }
  else return '不支持的操作';
  pushMusic();
  return null;
}
function plClear() { if (PL.cur) { clearTimeout(PL.cur.timer); clearTimeout(PL.cur.watch); if (PL.cur.ne) clearTimeout(PL.cur.ne.fail); } }
function plStop() { if (PL.cur) { plClear(); PL.cur = null; } }
function plNext(qid) {   // 当前歌曲播完 / 被切掉
  if (!PL.cur || (qid && PL.cur.qid !== qid)) return;
  plClear();
  const row = db.prepare('SELECT * FROM playlist WHERE qid=?').get(PL.cur.qid);
  if (row) { PL.lastKey.set(row.user_id, Math.max(PL.lastKey.get(row.user_id) || 0, row.k)); PL.curKey = row.k; db.prepare('DELETE FROM playlist WHERE qid=?').run(row.qid); }
  PL.cur = null; plStart(); pushMusic();
}
function plRemove(qid) {
  if (PL.cur && PL.cur.qid === qid) return plNext(qid);
  db.prepare('DELETE FROM playlist WHERE qid=?').run(qid); pushMusic();
}
function plDropMusic(mid) {
  for (const r of db.prepare('SELECT qid FROM playlist WHERE music_id=?').all(mid)) {
    if (PL.cur && PL.cur.qid === r.qid) plNext(r.qid); else db.prepare('DELETE FROM playlist WHERE qid=?').run(r.qid);
  }
  pushMusic();
}
function plAdd(u, mid) {
  const g = groupSettings();
  if (!g.music) return '群聊音乐还没有开启';
  const m = okHex(mid) && musicById.get(String(mid));
  if (!m || m.user_id !== u.id) return '只能点自己音乐仓库里的歌';
  if (db.prepare('SELECT 1 FROM playlist WHERE music_id=?').get(m.id)) return '这首歌已经在歌单里了';
  const rows = plRows(), mine = rows.filter(r => r.user_id === u.id);
  if (mine.length >= g.per) return `每人最多同时点 ${g.per} 首，等你的歌播完再来`;
  const pin = rows.find(r => r.pin), K = pin ? pin.k : rows.length ? Math.min(...rows.map(r => r.k)) : PL.curKey;
  const last = Math.max(PL.lastKey.get(u.id) || 0, ...mine.map(r => r.k));
  const k = Math.max(K, last + 1, 1), ts = Date.now();
  db.prepare('INSERT INTO playlist(music_id,user_id,k,added) VALUES(?,?,?,?)').run(m.id, u.id, k, ts);
  const r = db.prepare("INSERT INTO messages(user_id,text,ts,kind) VALUES(?,?,?,'song')").run(u.id, m.title, ts);
  io.emit('msg', msgOut(msgRow.get(Number(r.lastInsertRowid))));
  plStart(); pushMusic();
  return null;
}
// ================= v0.10：网易云音乐（只搜索 + 点歌，不需要登录网易云） =================
// 搜索由服务器代为请求（浏览器直接请求会被跨域拦住），播放则由每个人的浏览器直接从网易云加载，不经过这台电脑。
const NE_API = process.env.NETEASE_SEARCH_URL || 'https://music.163.com/api/cloudsearch/pc';   // 环境变量只给测试用
const NE_DETAIL = process.env.NETEASE_DETAIL_URL || 'https://music.163.com/api/song/detail';
const NE_MEDIA = process.env.NETEASE_MEDIA || 'https://music.163.com/song/media/outer/url?id={id}.mp3';
const NE_WAIT = Number(process.env.NETEASE_WAIT_MS) || 20000;   // 开播后多久还没人加载成功就跳过
const NE_FAIL_GRACE = 2500;   // 有人报“放不了”后再等一会儿，看看别人能不能放（大家所在地区可能不同）
const NE_HDR = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Referer: 'https://music.163.com/', Accept: 'application/json' };
const neCache = new Map();   // 搜索结果缓存：关键词 -> { t, items }
const neSongs = new Map();   // 搜到过的歌：id -> 歌曲信息（点歌时直接用，不相信浏览器传来的歌名）
const neHits = new Map();    // 每人每分钟最多搜 NE_RATE 次
const NE_RATE = 20;
const neCover = u => { u = String(u || '').replace(/^http:/, 'https:'); return /^https:\/\/p\d+\.music\.126\.net\/[\w\-=\/.]+\.(jpg|jpeg|png|webp)$/i.test(u) ? u + '?param=120y120' : ''; };
function neSong(s) {
  const p = s.privilege || {}, fee = Number(s.fee) || 0;
  const o = {
    id: String(s.id), title: clean(s.name, 80) || '未知歌曲',
    artist: clean((s.ar || s.artists || []).map(a => a && a.name).filter(Boolean).join(' / '), 80),
    album: clean((s.al || s.album || {}).name, 80), cover: neCover((s.al || s.album || {}).picUrl),
    dur: Math.round((Number(s.dt || s.duration) || 0) / 10) / 100,
    vip: fee === 1 || fee === 4,                                   // VIP / 付费专辑：外链放不了
    buy: fee === 4,                                                // 付费专辑：会员也放不了
    blocked: s.privilege ? (p.st < 0 || p.pl === 0) : false        // 服务器所在地区没有版权（大家所在地区不同，结果可能不一样）
  };
  if (/^\d{1,12}$/.test(o.id) && o.dur > 0) { neSongs.set(o.id, o); if (neSongs.size > 2000) neSongs.delete(neSongs.keys().next().value); }
  return o;
}
async function neFetch(url) {
  const r = await fetch(url, { headers: NE_HDR, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
app.get('/api/netease/search', async (req, res) => {
  const u = userOf(req); if (!u) return res.status(401).json({ error: '请先登录' });
  const q = clean(req.query.q, 60).replace(/\s+/g, ' '), key = q.toLowerCase();
  if (!q) return res.status(400).json({ error: '请输入歌名或歌手' });
  res.set('Cache-Control', 'no-store');
  const hit = neCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60e3) return res.json({ q, items: hit.items, cached: true });
  const now = Date.now(), h = (neHits.get(u.id) || []).filter(t => now - t < 60e3);
  if (h.length >= NE_RATE) return res.status(429).json({ error: '搜得太快了，休息一下再试' });
  h.push(now); neHits.set(u.id, h);
  try {
    const j = await neFetch(NE_API + '?type=1&limit=20&offset=0&s=' + encodeURIComponent(q));
    if (j.code !== 200) throw new Error('code ' + j.code);
    const rank = s => s.vip ? 2 : s.blocked ? 1 : 0;   // 能放的排前面（原唱经常因为版权放不了，翻唱 / 其他版本反而能放）
    const items = ((j.result && j.result.songs) || []).map(neSong).filter(s => s.dur > 0).map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
    neCache.set(key, { t: Date.now(), items }); if (neCache.size > 300) neCache.delete(neCache.keys().next().value);
    res.json({ q, items });
  } catch (e) {
    res.status(502).json({ error: '网易云暂时连不上，稍后再试' });
  }
});
// 播放地址：网易云外链会 302 到 http:// 的 CDN 地址，https 页面里可能被拦（手机 Safari 尤其）。
// 服务器只请求一次跳转（不下载音乐），换成 https 地址交给浏览器直接播放；查不到就让浏览器自己用外链试试。
const neSrcs = new Map();   // id -> { t, p: Promise<url|null> }
function neResolve(id) {
  const h = neSrcs.get(id); if (h && Date.now() - h.t < 5 * 60e3) return h.p;
  const p = (async () => {
    try {
      const u = NE_MEDIA.replace('{id}', id), r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': NE_HDR['User-Agent'] }, signal: AbortSignal.timeout(6000) });
      if (r.body) r.body.cancel().catch(() => {});
      if (r.status === 200) return u;
      const loc = r.headers.get('location') || '';
      if (r.status < 300 || r.status > 399 || !loc || /\/404(\b|$)/.test(loc)) return null;
      const abs = new URL(loc, u).href.replace(/^http:\/\/([\w.-]+\.(126|163)\.net|music\.163\.com)\//, 'https://$1/');
      return process.env.NETEASE_MEDIA || /^https:\/\/[\w.-]+\.(126\.net|163\.com)\//.test(abs) ? abs : null;
    } catch (_) { neSrcs.delete(id); return null; }
  })();
  neSrcs.set(id, { t: Date.now(), p }); if (neSrcs.size > 500) neSrcs.delete(neSrcs.keys().next().value);
  return p;
}
app.get('/api/netease/:id/src', async (req, res) => {
  if (!userOf(req)) return res.status(401).json({ error: '请先登录' });
  const id = String(req.params.id); if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: '歌曲不存在' });
  res.set('Cache-Control', 'no-store').json({ url: await neResolve(id) });
});
async function neInfo(id) {
  if (neSongs.has(id)) return neSongs.get(id);
  try { const j = await neFetch(NE_DETAIL + '?ids=' + encodeURIComponent('[' + id + ']')); const s = j.songs && j.songs[0]; return s && String(s.id) === id ? neSong(s) : null; } catch (_) { return null; }
}
async function plAddNe(u, nid, own) {
  const g = groupSettings();
  if (!g.music) return '群聊音乐还没有开启';
  nid = String(nid || ''); if (!/^\d{1,12}$/.test(nid)) return '歌曲不存在';
  const s = await neInfo(nid);
  if (!s || !(s.dur > 0)) return '找不到这首歌';
  if (s.buy) return '这首在付费专辑里，放不了';
  if (s.vip && !own) return '这首是 VIP / 付费歌曲，需要会员才能放';   // v0.20：登录了网易云会员的桌面版可以点（只有能放的人听得到）
  const mid = 'ne:' + nid;
  if (db.prepare('SELECT 1 FROM playlist WHERE music_id=?').get(mid)) return '这首歌已经在歌单里了';
  const rows = plRows(), mine = rows.filter(r => r.user_id === u.id);
  if (mine.length >= g.per) return `每人最多同时点 ${g.per} 首，等你的歌播完再来`;
  const pin = rows.find(r => r.pin), K = pin ? pin.k : rows.length ? Math.min(...rows.map(r => r.k)) : PL.curKey;
  const last = Math.max(PL.lastKey.get(u.id) || 0, ...mine.map(r => r.k));
  const k = Math.max(K, last + 1, 1), ts = Date.now();
  db.prepare("INSERT INTO playlist(music_id,user_id,k,added,src,ntitle,nartist,ncover,ndur) VALUES(?,?,?,?,'netease',?,?,?,?)").run(mid, u.id, k, ts, s.title, s.artist, s.cover, s.dur);
  if (s.vip) db.prepare('UPDATE playlist SET nvip=1 WHERE music_id=?').run(mid);
  const r = db.prepare("INSERT INTO messages(user_id,text,ts,kind) VALUES(?,?,?,'song')").run(u.id, s.title, ts);
  io.emit('msg', msgOut(msgRow.get(Number(r.lastInsertRowid))));
  plStart(); pushMusic();
  return null;
}
function neSkip(qid, reason) {
  const c = PL.cur; if (!c || c.qid !== qid || !c.ne || c.ne.ok) return;
  const row = plRows().find(r => r.qid === qid);
  io.emit('music:skipped', { qid, title: row ? row.title : '', reason });
  plNext(qid);
}
// ================= v0.20：下载网易云歌曲到自己电脑（Hush 5 级解锁） =================
// 下载由桌面版用你自己的网易云账号完成，文件只存在你的电脑上，不经过、也不上传到这台服务器。
// 服务器只负责把关：5 级以上才发一张 2 分钟有效、只能用一次的“下载许可”，桌面版下载前拿许可来核对。
const NE_DL_LEVEL = Number(process.env.NETEASE_DL_LEVEL) || 5;
const NE_DL_PER_HOUR = Number(process.env.NETEASE_DL_PER_HOUR) || 30;
const NE_DL_TTL = 120e3;
const neDlHits = new Map(), neDlUsed = new Map();
const dlSign = b => crypto.createHmac('sha256', SIGN_SECRET).update('nedl.' + b).digest('base64url');
app.get('/api/netease/dl-perm', (req, res) => {   // 只看自己能不能下载（给界面显示锁）
  const u = userOf(req); if (!u) return res.status(401).json({ error: '请先登录' });
  const L = level(u.xp), now = Date.now(), h = (neDlHits.get(u.id) || []).filter(t => now - t < 3600e3);
  res.set('Cache-Control', 'no-store').json({ ok: L >= NE_DL_LEVEL, level: L, need: NE_DL_LEVEL, left: Math.max(0, NE_DL_PER_HOUR - h.length), perHour: NE_DL_PER_HOUR });
});
app.post('/api/netease/dl-perm', (req, res) => {
  const u = userOf(req); if (!u) return res.status(401).json({ error: '请先登录' });
  res.set('Cache-Control', 'no-store');
  const id = String((req.body && req.body.id) || ''); if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: '歌曲不存在' });
  const L = level(u.xp);
  if (L < NE_DL_LEVEL) return res.status(403).json({ error: `Hush 账号 ${NE_DL_LEVEL} 级才能下载（你现在 ${L} 级）`, code: 'level', level: L, need: NE_DL_LEVEL });
  const now = Date.now(), h = (neDlHits.get(u.id) || []).filter(t => now - t < 3600e3);
  if (h.length >= NE_DL_PER_HOUR) return res.status(429).json({ error: `一小时最多下载 ${NE_DL_PER_HOUR} 首，休息一下再来`, code: 'rate' });
  h.push(now); neDlHits.set(u.id, h);
  const b = Buffer.from(JSON.stringify({ u: u.id, id, e: now + NE_DL_TTL, n: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
  res.json({ t: b + '.' + dlSign(b), exp: now + NE_DL_TTL, left: NE_DL_PER_HOUR - h.length });
});
app.post('/api/netease/dl-verify', (req, res) => {   // 桌面版主进程核对许可（一次性）
  res.set('Cache-Control', 'no-store');
  const t = String((req.body && req.body.t) || ''), [b, sg] = t.split('.');
  let o = null; try { if (b && sg && crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(dlSign(b)))) o = JSON.parse(Buffer.from(b, 'base64url').toString()); } catch (_) { o = null; }
  const now = Date.now();
  for (const [k, e] of neDlUsed) if (e < now) neDlUsed.delete(k);
  if (!o || !(o.e > now) || neDlUsed.has(o.n) || String(req.body.id || '') !== o.id) return res.status(403).json({ ok: false, error: '下载许可无效或已过期' });
  const u = userById.get(o.u); if (!u || level(u.xp) < NE_DL_LEVEL) return res.status(403).json({ ok: false, error: '等级不够' });
  neDlUsed.set(o.n, o.e);
  res.json({ ok: true, uid: o.u, id: o.id });
});

// ================= v0.19：歌词（歌词字幕） =================
// 来源（按顺序）：① 歌曲文件里内嵌的歌词（上传时读出，旧歌第一次打开时补读）② 自己上传的 .lrc
// ③ 网易云的歌：网易云自带歌词 ④ LRCLIB（https://lrclib.net，免费、不要密钥）按歌名 / 歌手 / 时长查。
// 查到的结果存进数据库，下次直接用；查不到也记下来（几天后再试），不会每次都去问。
// 说明：自己上传的 .lrc 是明确的选择，会盖过①③④；内嵌的只有纯文本时，会再去网上找有时间轴的版本，找不到才用纯文本。
const LY = require('./lyrics');
db.exec('CREATE TABLE IF NOT EXISTS lyrics(k TEXT PRIMARY KEY, src TEXT, raw TEXT, tr TEXT, fetched INTEGER, user_id INTEGER)');
const LRCLIB = (process.env.LRCLIB_URL || 'https://lrclib.net').replace(/\/+$/, '');
const NE_LYRIC = process.env.NETEASE_LYRIC || 'https://music.163.com/api/song/lyric?id={id}&lv=1&tv=-1';
const LY_ONLINE = process.env.LYRICS_ONLINE !== '0';
const LY_UA = `Hush/${VERSION} (self-hosted group chat; https://github.com/ryuu-177/hush)`;
const LY_NONE_TTL = 3 * 864e5;          // 没找到：3 天后再试
const LRC_MAX = 256 * 1024;             // 上传的 .lrc 最大 256KB
const lyRow = db.prepare('SELECT * FROM lyrics WHERE k=?');
const lySave = (k, src, raw, tr, uid) => db.prepare('INSERT INTO lyrics(k,src,raw,tr,fetched,user_id) VALUES(?,?,?,?,?,?) ON CONFLICT(k) DO UPDATE SET src=excluded.src,raw=excluded.raw,tr=excluded.tr,fetched=excluded.fetched,user_id=excluded.user_id').run(k, src, raw || null, tr || null, Date.now(), uid || null);
const lyParsed = new Map();             // 解析结果缓存：k|fetched -> 结果
function lyOut(row) {
  if (!row || row.src === 'none' || !row.raw) return { kind: 'none', src: row ? row.src : null };
  const ck = row.k + '|' + row.fetched;
  let o = lyParsed.get(ck);
  if (!o) {
    const p = LY.parseLrc(row.raw);
    if (row.tr && row.tr !== '-') LY.mergeTrans(p, LY.parseLrc(row.tr));
    o = p.synced ? { kind: 'sync', src: row.src, lines: p.lines.map(l => l.tr ? { t: l.t, x: l.x, tr: l.tr } : { t: l.t, x: l.x }) } : p.plain ? { kind: 'plain', src: row.src, text: p.plain } : { kind: 'none', src: row.src };
    lyParsed.set(ck, o); if (lyParsed.size > 200) lyParsed.delete(lyParsed.keys().next().value);
  }
  return { ...o, by: row.src === 'lrc' ? row.user_id : undefined };
}
addCol('music', 'artist', 'TEXT'); addCol('music', 'album', 'TEXT'); addCol('music', 'tagged', 'INTEGER DEFAULT 0');
// 读歌曲文件里的标签：歌手 / 专辑 / 内嵌歌词（上传后马上读；旧歌第一次需要时再读）
function scanTags(id) {
  const m = musicById.get(id); if (!m) return null;
  const tags = LY.readTags(path.join(MUSIC_DIR, m.id));
  db.prepare('UPDATE music SET artist=?, album=?, tagged=1 WHERE id=?').run(clean(tags.artist, 80) || null, clean(tags.album, 80) || null, m.id);
  const emb = LY.embedded(tags), row = lyRow.get(m.id);
  // 内嵌歌词可以覆盖：还没有 / 没找到 / 旧的内嵌；有时间轴的内嵌也比网上查到的优先。自己传的 .lrc 不动
  if (emb && (!row || row.src === 'none' || row.src === 'tag' || (row.src === 'lrclib' && emb.parsed.synced))) lySave(m.id, 'tag', emb.raw, null, null);
  return tags;
}
// ----- LRCLIB：按顺序一个一个问（官方要求），遇到 429 按 Retry-After 等 -----
let lrclibWait = 0, lrclibQ = Promise.resolve();
function lrclibGet(p) {
  const run = async () => {
    if (Date.now() < lrclibWait) throw new Error('rate');
    const r = await fetch(LRCLIB + p, { headers: { 'User-Agent': LY_UA, 'Lrclib-Client': LY_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (r.status === 429 || r.status === 503) { const ra = Number(r.headers.get('retry-after')) || 30; lrclibWait = Date.now() + ra * 1000 * (1 + Math.random() * 0.3); throw new Error('rate'); }
    if (r.status === 404) return null;
    if (!r.ok || !/json/i.test(r.headers.get('content-type') || '')) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const p2 = lrclibQ.then(run, run);
  lrclibQ = p2.then(() => new Promise(r => setTimeout(r, 250)), () => new Promise(r => setTimeout(r, 250)));
  return p2;
}
const lyNorm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
const lyTitleOk = (a, b) => { a = lyNorm(a); b = lyNorm(b); return !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a)))); };
// 返回 { raw } / { none:true }（确认没有）；网络问题抛错（不记“没有”）
async function lrclibFind({ title, artist, album, dur }) {
  const cands = artist ? [{ title, artist }] : LY.guessArtistTitle(title);
  const okRec = j => j && !Array.isArray(j) && (j.syncedLyrics || j.plainLyrics || j.instrumental);
  const pick = (arr, c, strict) => {
    if (!Array.isArray(arr)) return null;
    const ok = arr.filter(j => (j.syncedLyrics || j.plainLyrics) && lyTitleOk(j.trackName, c.title) && (!c.artist || lyTitleOk(j.artistName, c.artist) || !strict) && (!dur || Math.abs((j.duration || 0) - dur) <= (strict ? 2 : 3)));
    ok.sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) || Math.abs(a.duration - dur) - Math.abs(b.duration - dur));
    return ok[0] || null;
  };
  let n = 0;
  for (const c of cands) {
    if (!c.title || n >= 4) continue;
    if (c.artist) {
      n++;
      const q = '/api/get?track_name=' + encodeURIComponent(c.title) + '&artist_name=' + encodeURIComponent(c.artist) + (album ? '&album_name=' + encodeURIComponent(album) : '') + (dur >= 1 && dur <= 3600 ? '&duration=' + Math.round(dur) : '');
      const j = await lrclibGet(q);
      if (okRec(j)) return j.instrumental ? { none: true, instrumental: true } : { raw: j.syncedLyrics || j.plainLyrics };
      n++;
      const s = pick(await lrclibGet('/api/search?track_name=' + encodeURIComponent(c.title) + '&artist_name=' + encodeURIComponent(c.artist)), c, false);
      if (s) return { raw: s.syncedLyrics || s.plainLyrics };
    } else {
      n++;
      const s = pick(await lrclibGet('/api/search?q=' + encodeURIComponent(c.title)), c, true);
      if (s) return { raw: s.syncedLyrics || s.plainLyrics };
    }
  }
  return { none: true };
}
async function neLyric(nid) {
  const j = await neFetch(NE_LYRIC.replace('{id}', nid));
  if (!j || j.code !== 200) throw new Error('code');
  if (j.nolyric) return { none: true, instrumental: true };
  const raw = j.lrc && j.lrc.lyric, tr = j.tlyric && j.tlyric.lyric;
  return raw && LY.parseLrc(raw).lines.length + (LY.parseLrc(raw).plain ? 1 : 0) ? { raw, tr } : { none: true };
}
const lyBusy = new Map(), lyErr = new Map();   // 正在查的 / 最近查失败的（5 分钟内不重试）
// k：音乐 id 或 'ne:<网易云 id>'；info：{ title, artist, album, dur, nid }
function lyResolve(k, info) {
  const row = lyRow.get(k);
  const fresh = row && (row.src !== 'none' || Date.now() - row.fetched < LY_NONE_TTL);
  // 内嵌的只有纯文本：还要去网上找有时间轴的（只找一次）
  const wantSync = row && row.src === 'tag' && !row.tr && !LY.parseLrc(row.raw).synced;   // tr='-' 表示已经找过
  if (fresh && !wantSync) return Promise.resolve(lyOut(row));
  if (!LY_ONLINE || (lyErr.get(k) || 0) > Date.now()) return Promise.resolve(row ? lyOut(row) : { kind: 'none', src: null, retry: true });
  if (lyBusy.has(k)) return lyBusy.get(k);
  const p = (async () => {
    try {
      let r = null, src = null;
      if (info.nid) { try { r = await neLyric(info.nid); src = 'netease'; } catch (_) { r = null; } }
      if (!r || r.none && !r.instrumental) { r = await lrclibFind(info); src = 'lrclib'; }
      const cur = lyRow.get(k);
      if (cur && cur.src === 'lrc') return lyOut(cur);   // 查的时候用户自己传了 .lrc
      if (wantSync) {
        if (r.raw && LY.parseLrc(r.raw).synced) lySave(k, src, r.raw, r.tr, null);
        else db.prepare("UPDATE lyrics SET tr='-', fetched=? WHERE k=? AND src='tag'").run(Date.now(), k);   // 标记“已经找过”，继续用内嵌的纯文本
        return lyOut(lyRow.get(k));
      }
      if (r.raw) lySave(k, src, r.raw, r.tr, null);
      else if (!cur || cur.src === 'none') lySave(k, 'none', null, null, null);
      return lyOut(lyRow.get(k));
    } catch (e) {
      lyErr.set(k, Date.now() + 5 * 60e3); if (lyErr.size > 500) lyErr.delete(lyErr.keys().next().value);
      const cur = lyRow.get(k);
      return cur ? lyOut(cur) : { kind: 'none', src: null, retry: true };
    } finally { lyBusy.delete(k); }
  })();
  lyBusy.set(k, p);
  return p;
}
const canSee = (u, m) => m && (m.user_id === u.id || u.is_admin || !!db.prepare('SELECT 1 FROM playlist WHERE music_id=?').get(m.id));
app.get('/api/lyrics/m/:id', async (req, res) => {
  const u = userOf(req); if (!u) return res.status(401).json({ error: '请先登录' });
  let m = okHex(req.params.id) && musicById.get(String(req.params.id));
  if (!canSee(u, m)) return res.status(404).json({ error: '歌曲不存在' });
  if (!m.tagged) { scanTags(m.id); m = musicById.get(m.id); }
  const out = await lyResolve(m.id, { title: m.title, artist: m.artist || '', album: m.album || '', dur: m.dur });
  res.set('Cache-Control', 'no-store').json({ ...out, k: m.id, mine: out.by === u.id, canEdit: m.user_id === u.id || !!u.is_admin });
});
app.get('/api/lyrics/ne/:nid', async (req, res) => {
  const u = userOf(req); if (!u) return res.status(401).json({ error: '请先登录' });
  const nid = String(req.params.nid); if (!/^\d{1,12}$/.test(nid)) return res.status(404).json({ error: '歌曲不存在' });
  const k = 'ne:' + nid, p = db.prepare("SELECT * FROM playlist WHERE music_id=? AND src='netease'").get(k);
  if (!p && !lyRow.get(k)) return res.status(404).json({ error: '这首歌不在歌单里' });   // 只查歌单里的歌，不当成通用的歌词代理
  const out = await lyResolve(k, { nid, title: p ? p.ntitle : '', artist: p ? (p.nartist || '').split(' / ')[0] : '', dur: p ? p.ndur : 0 });
  res.set('Cache-Control', 'no-store').json({ ...out, k, mine: false, canEdit: false });
});
// 上传 / 替换 .lrc（请求体就是文件内容）
app.put('/api/lyrics/m/:id', (req, res) => {
  const u = userOf(req);
  const no = (c, e) => { req.resume(); res.status(c).json({ error: e }); };
  if (!u) return no(401, '请先登录');
  const m = okHex(req.params.id) && musicById.get(String(req.params.id));
  if (!m || (m.user_id !== u.id && !u.is_admin)) return no(404, '歌曲不存在');
  if (Number(req.headers['content-length']) > LRC_MAX) return no(413, '歌词文件太大（最大 256KB）');
  const chunks = []; let size = 0, over = false;
  req.on('data', c => { size += c.length; if (size > LRC_MAX) { if (!over) { over = true; res.status(413).json({ error: '歌词文件太大（最大 256KB）' }); } req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (over) return;
    const text = LY.decodeText(Buffer.concat(chunks)).replace(/\u0000/g, '');
    const p = LY.parseLrc(text);
    if (!p.synced && !p.plain) return res.status(400).json({ error: '这个文件里没有读出歌词' });
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2000)) && !p.synced) return res.status(415).json({ error: '这不是歌词文件（.lrc / .txt）' });
    lySave(m.id, 'lrc', text.slice(0, LY.MAX_LYRIC), null, u.id);
    io.emit('lyrics', { k: m.id });
    res.json({ ...lyOut(lyRow.get(m.id)), k: m.id, mine: true, canEdit: true });
  });
});
app.delete('/api/lyrics/m/:id', async (req, res) => {
  const u = userOf(req); if (!u) return res.status(401).json({ error: '请先登录' });
  const m = okHex(req.params.id) && musicById.get(String(req.params.id));
  if (!m || (m.user_id !== u.id && !u.is_admin)) return res.status(404).json({ error: '歌曲不存在' });
  const row = lyRow.get(m.id);
  if (row && row.src === 'lrc') { db.prepare('DELETE FROM lyrics WHERE k=?').run(m.id); scanTags(m.id); lyErr.delete(m.id); }
  io.emit('lyrics', { k: m.id });
  res.json({ ok: true });
});

setTimeout(() => { plStart(); }, 0);   // 重启后：歌单还在、音乐开着，就从第一首重新开始

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
    const r = db.prepare('INSERT INTO users(name,salt,hash,is_admin,created) VALUES(?,?,?,?,?)').run(name, salt, hashPw(pw, salt), first ? 1 : 0, Date.now());
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

// ---------- v0.18：账号门户用的接口（浏览器和桌面版都能用） ----------
const bearer = req => (req.headers.authorization || '').replace('Bearer ', '');
// 老账号补一个估算的注册时间：最早的消息 / 文件 / 歌曲；都没有就用现在
for (const u of db.prepare('SELECT id FROM users WHERE created IS NULL').all()) {
  const t = Math.min(...[db.prepare('SELECT MIN(ts) t FROM messages WHERE user_id=?').get(u.id).t, db.prepare('SELECT MIN(created) t FROM files WHERE user_id=?').get(u.id).t, db.prepare('SELECT MIN(created) t FROM music WHERE user_id=?').get(u.id).t].filter(Boolean).concat(Date.now()));
  db.prepare('UPDATE users SET created=?, created_est=1 WHERE id=?').run(t, u.id);
}
app.get('/api/me', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const L = level(u.xp), q = sql => db.prepare(sql).get(u.id).n;
  const music = { used: q('SELECT COUNT(*) n FROM music WHERE user_id=?'), quota: musicQuota(L), cap: MUSIC_CAP, next: nextUnlock(L) };
  const stats = {
    messages: q("SELECT COUNT(*) n FROM messages WHERE user_id=? AND COALESCE(recalled,0)=0 AND COALESCE(kind,'') NOT IN ('song','live')"),
    files: q('SELECT COUNT(*) n FROM files WHERE user_id=? AND deleted=0 AND COALESCE(sticker,0)=0'),
    songs: q("SELECT COUNT(*) n FROM messages WHERE user_id=? AND kind='song'")
  };
  res.set('Cache-Control', 'no-store').json({ ...info(u), role: u.is_admin ? 'admin' : 'member', created: u.created || null, createdEst: !!u.created_est, music, stats, app: isApp(req), webChat: WEB_CHAT });
});
// 改密码：要先输对旧密码；改完后其他设备上的登录全部失效（当前这个保留）
app.post('/api/password', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const old = String((req.body || {}).old || ''), pw = String((req.body || {}).password || '');
  const ok = crypto.timingSafeEqual(Buffer.from(hashPw(old, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) { fail(req); return res.status(403).json({ error: '旧密码不对' }); }
  if (pw.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  if (pw.length > 200) return res.status(400).json({ error: '新密码太长了' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(pw, salt), u.id);
  const keep = bearer(req);
  const gone = db.prepare('SELECT token FROM sessions WHERE user_id=? AND token<>?').all(u.id, keep).map(r => r.token);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, keep);
  for (const s of io.sockets.sockets.values()) if (gone.includes(s.data.token)) s.disconnect(true);
  res.json({ ok: true, others: gone.length });
});
// 退出登录：作废当前这个登录（别的设备不受影响）
app.post('/api/logout', (req, res) => {
  const t = bearer(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.json({ ok: true });
});

// ---------- 实时聊天 ----------
const server = http.createServer(app);
const io = new Server(server);
// v0.21.3：连接日志（断线排查用）。logs/conn.log，超过 1MB 轮转成 conn.log.1，只留两份
const CONN_LOG = path.join(__dirname, 'logs', 'conn.log');
try { fs.mkdirSync(path.dirname(CONN_LOG), { recursive: true }); } catch (_) {}
function connLog(ev, socket, extra) {
  try {
    if (fs.existsSync(CONN_LOG) && fs.statSync(CONN_LOG).size > 1024 * 1024) fs.renameSync(CONN_LOG, CONN_LOG + '.1');
    const h = socket.handshake, u = userById.get(socket.userId);
    const ip = h.headers['cf-connecting-ip'] || h.address || '';
    fs.appendFileSync(CONN_LOG, [new Date().toISOString(), ev, u ? u.name : '?', ip, h.headers['cf-ipcountry'] || '', socket.id, extra || ''].join('\t') + '\n');
  } catch (_) {}
}
// v0.21.3：语音断线宽限。意外断线后先不把人移出语音房 / 不挂断通话，VOICE_GRACE_MS 内重连就无缝接回
const VOICE_GRACE_MS = Number(process.env.VOICE_GRACE_MS) || 20000;
const roomGrace = new Map();   // 用户 id -> 计时器
const callGrace = new Map();   // 用户 id -> 计时器
const online = new Map();   // socket.id -> 用户名
const onlineIds = new Map();   // socket.id -> 用户 id
const lastXp = new Map();   // 用户 id -> 上次得经验的时间

io.use((socket, next) => {
  // v0.18：只接受桌面版（User-Agent 带 Hush/… Electron/…，并且页面握手里说明 client:'desktop'）。
  // 升级那一刻桌面版里还开着的旧页面（v0.17 及以前）握手里没有 client，只要 User-Agent 是桌面版就放行，
  // 不然它会一直连不上，直到用户手动刷新。浏览器的 User-Agent 不带 Hush/Electron，照样被拒。
  const a = socket.handshake.auth || {};
  if (!WEB_CHAT && !(isApp(socket.handshake) && (a.client === 'desktop' || a.client === undefined))) return next(new Error('desktop-only'));
  const u = userByToken.get(String(a.token || ''));
  if (!u) return next(new Error('auth'));
  socket.userId = u.id; socket.data.token = String(a.token);
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
  for (const id of [uid, c.peer]) { clearTimeout(callGrace.get(id)); callGrace.delete(id); }
  toSide(c, uid, 'call:end', { reason });
  if (p) toSide(p, c.peer, 'call:end', { reason });
}
const pushRoom = () => io.emit('room', { max: ROOM_MAX, members: [...room.keys()].map(id => profile(userById.get(id))) });
function leaveRoom(uid, sid) {
  if (room.get(uid) !== sid) return;
  clearTimeout(roomGrace.get(uid)); roomGrace.delete(uid);
  room.delete(uid);
  const name = userById.get(uid).name;
  for (const s of room.values()) io.to(s).emit('room:left', { name });
  pushRoom();
}

// ---------- 屏幕直播信令（v0.6）：一对多，主播给每位观众单独建一条只发送的连接 ----------
const lives = new Map();   // 主播 id -> { sock: 主播 socket.id, viewers: Map(观众 id -> socket.id) }
const liveList = () => [...lives.keys()].map(id => userById.get(id).name);
const pushLive = () => io.emit('live', liveList());
// v0.11：聊天里的“某某 开始共享屏幕 / 结束了屏幕共享”系统行。防刷屏：
// 开始后 LIVE_ON_MS 内又停了 → 两条都不发；停了以后 LIVE_OFF_MS 内又开始（手滑、断线重连）→ 两条都不发。
const LIVE_ON_MS = Number(process.env.LIVE_ON_MS) || 3000, LIVE_OFF_MS = Number(process.env.LIVE_OFF_MS) || 10000, LIVE_DROP_MS = Number(process.env.LIVE_DROP_MS) || 20000;
const liveNote = new Map();   // 用户 id -> { shown: 聊天里最后一条是“开始”, on: 计时器, off: 计时器 }
function livePost(uid, on) {
  const r = db.prepare("INSERT INTO messages(user_id,text,ts,kind) VALUES(?,?,?,'live')").run(uid, on ? '1' : '0', Date.now());
  io.emit('msg', msgOut(msgRow.get(Number(r.lastInsertRowid))));
}
function liveNoteOn(uid) {
  const n = liveNote.get(uid) || {}; liveNote.set(uid, n);
  if (n.off) { clearTimeout(n.off); n.off = null; return; }   // 刚停又开：什么都不发
  if (n.shown || n.on) return;
  n.on = setTimeout(() => { n.on = null; if (lives.has(uid)) { n.shown = true; livePost(uid, true); } }, LIVE_ON_MS);
}
function liveNoteOff(uid, dropped) {
  const n = liveNote.get(uid); if (!n) return;
  if (n.on) { clearTimeout(n.on); n.on = null; return; }      // 刚开就停：什么都不发
  if (!n.shown || n.off) return;
  n.off = setTimeout(() => { n.off = null; if (!lives.has(uid)) { n.shown = false; livePost(uid, false); } }, dropped ? LIVE_DROP_MS : LIVE_OFF_MS);
}
function endLive(uid, dropped) {
  const L = lives.get(uid); if (!L) return;
  lives.delete(uid); liveNoteOff(uid, dropped);
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

// ---------- v0.21.3 已读回执 ----------
const READ_MS = Number(process.env.READ_MS) || 1000;   // 每人最多每秒广播一次，期间的多次上报合并成最新一条
const readSet = db.prepare('INSERT INTO reads(user_id,last,ts) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET last=MAX(last,excluded.last), ts=excluded.ts');
const readOf = db.prepare('SELECT last FROM reads WHERE user_id=?');
const maxMsgId = db.prepare('SELECT MAX(id) n FROM messages');
const msgExists = db.prepare('SELECT 1 FROM messages WHERE id=?');
const readPend = new Map();   // 用户 id -> { t: 计时器, at: 上次广播时间, id: 待广播的编号 }
// 给某个用户看的 reads：自己开了隐藏 → 空；否则所有没隐藏的成员（不含自己）
const readsFor = uid => {
  const u = userById.get(uid); if (!u || u.hide_read) return {};
  const o = {};
  for (const r of db.prepare('SELECT u.name, r.last FROM reads r JOIN users u ON u.id=r.user_id WHERE COALESCE(u.hide_read,0)=0 AND r.user_id<>? AND r.last>0').all(uid)) o[r.name] = r.last;
  return o;
};
// 发给除了本人、以及开了隐藏的人之外的所有在线 socket
const readCast = (uid, ev, d) => {
  const hidden = new Map();
  for (const [sid, id] of onlineIds) {
    if (id === uid) continue;
    if (!hidden.has(id)) hidden.set(id, !!(userById.get(id) || {}).hide_read);
    if (!hidden.get(id)) io.to(sid).emit(ev, d);
  }
};
function readFlush(uid) {
  const p = readPend.get(uid); if (!p) return;
  p.t = null; p.at = Date.now();
  const u = userById.get(uid); if (!u || u.hide_read || p.id == null) { p.id = null; return; }
  readCast(uid, 'read:update', { name: u.name, id: p.id }); p.id = null;
}
function readMark(uid, raw) {
  const id = Number(typeof raw === 'object' && raw ? raw.id : raw);
  if (!Number.isInteger(id) || id <= 0) return;
  if (id > (maxMsgId.get().n || 0) || !msgExists.get(id)) return;   // 必须是真实存在的消息
  const cur = (readOf.get(uid) || {}).last || 0;
  if (id <= cur) return;                                              // 只增不减
  readSet.run(uid, id, Date.now());
  const p = readPend.get(uid) || { t: null, at: 0, id: null }; readPend.set(uid, p);
  p.id = id;
  if (p.t) return;
  const wait = p.at + READ_MS - Date.now();
  if (wait <= 0) readFlush(uid); else p.t = setTimeout(() => readFlush(uid), wait);
}

io.on('connection', socket => {
  const me = userById.get(socket.userId);
  connLog('connect', socket, 'since=' + (parseInt(socket.handshake.auth.since) || 0));
  online.set(socket.id, me.name); onlineIds.set(socket.id, me.id);
  socket.emit('me', info(me));
  socket.emit('ver', VERSION);   // v0.8：页面版本和服务器不一致时，提示刷新

  // 断线重连：客户端带上最后收到的消息 id，只补发错过的消息；太多就整页重发
  const since = parseInt(socket.handshake.auth.since) || 0;
  const missed = since ? msgSel('m.id>? ORDER BY m.id ASC LIMIT 301').all(since) : null;
  if (missed && missed.length <= 300) {
    const recalledIds = db.prepare('SELECT id FROM messages WHERE recalled=1 AND id<=? AND id>?').all(since, since - 500).map(r => r.id);
    socket.emit('resync', { messages: missed.map(msgOut), recalled: recalledIds, reads: readsFor(me.id) });
  } else {
    const rows = msgSel('1 ORDER BY m.id DESC LIMIT 50').all().reverse();
    socket.emit('history', rows.map(msgOut));
  }
  socket.emit('reads', readsFor(me.id));   // v0.21.3：history 是数组，加字段会破坏旧客户端，所以紧跟着单独发一条
  pushOnline();

  socket.on('read', id => readMark(me.id, id));
  socket.on('read:hide', (on, cb) => {   // v0.21.3：隐藏已读。开：别人那里撤掉我的头像；关：重新广播我读到的位置
    on = !!(on && typeof on === 'object' ? on.on : on);
    db.prepare('UPDATE users SET hide_read=? WHERE id=?').run(on ? 1 : 0, me.id);
    const u = userById.get(me.id), last = (readOf.get(me.id) || {}).last || 0;
    readCast(me.id, 'read:update', { name: u.name, id: on ? 0 : last });
    for (const sid of socketsOf(me.id)) { io.to(sid).emit('me', info(u)); io.to(sid).emit('reads', readsFor(me.id)); }
    ack(cb, { ok: true, hideRead: on });
  });
  socket.on('msg', m => {
    const o = typeof m === 'string' ? { text: m } : (m && typeof m === 'object' ? m : {});
    const text = (typeof o.text === 'string' ? o.text : '').trim().slice(0, 500);   // 原样保存，前端只用 textContent 显示
    if (!text) return;
    const ts = Date.now();
    let reply = parseInt(o.reply) || null;
    if (reply && !db.prepare('SELECT 1 FROM messages WHERE id=?').get(reply)) reply = null;
    // @提及：只认真实存在的用户名
    // v0.15：中文后面常常不加空格（“@小刘你好”），所以取 @ 后面“最长的、真实存在的用户名”
    //       规则：@ 前面不能紧挨英文字母 / 数字（排除邮箱），用户名后面紧跟的也不能是英文字母 / 数字（“@bobby” 不会算成 @bob）
    const ments = [...new Set([...text.matchAll(/@([^\s@]{1,16})/g)].map(x => {
      if (x.index > 0 && /[A-Za-z0-9._%+-]/.test(text[x.index - 1])) return null;
      for (let k = x[1].length; k >= 1; k--) if (!/[A-Za-z0-9_]/.test(x[1][k] || '') && userByName.get(x[1].slice(0, k))) return x[1].slice(0, k);
      return null;
    }).filter(Boolean))].slice(0, 20);
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
    // v0.17：表情包可能被很多条消息共用，只有没人再用时才删文件
    const shared = row.file_id && db.prepare('SELECT COUNT(*) n FROM messages WHERE file_id=? AND recalled=0 AND id<>?').get(row.file_id, row.id).n > 0;
    if (row.file_id && !shared) {
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
  // v0.21.3：通话中断线、宽限期内重连：接回通话。keep=对方的连接还通着，就不重建
  socket.on('call:resume', (o, cb) => {
    const c = calls.get(uid), p = c && calls.get(c.peer);
    if (!c || !p || c.state !== 'active' || !c.sock || c.sock === socket.id) return ack(cb, { gone: true });
    const old = c.sock;
    clearTimeout(callGrace.get(uid)); callGrace.delete(uid);
    c.sock = socket.id;
    io.sockets.sockets.get(old)?.disconnect(true);
    const keep = !!(o && o.keep);
    io.to(p.sock).emit('call:resumed', { name: me.name, keep });
    connLog('call-resume', socket);
    ack(cb, { ok: true, peer: userById.get(c.peer).name, keep });
  });
  socket.on('call:hangup', () => {
    const c = calls.get(uid);
    if (c && (c.sock === socket.id || !c.sock)) endCall(uid, c.sock ? 'hangup' : 'declined');
  });

  // ----- 语音房（多人，网状连接） -----
  socket.on('room:join', o => {
    // v0.21.3：断线重连后接回原来的位置（宽限期内，或者服务器还没发现旧连接已断）。其他人看不到“离开 / 加入”
    if (o && o.resume && room.has(uid) && room.get(uid) !== socket.id) {
      const old = room.get(uid), keep = new Set(Array.isArray(o.keep) ? o.keep.map(String) : []);
      clearTimeout(roomGrace.get(uid)); roomGrace.delete(uid);
      room.set(uid, socket.id);
      io.sockets.sockets.get(old)?.disconnect(true);   // 旧连接其实已经死了，只是服务器还没超时
      const peers = [];
      for (const [id, s] of room) if (id !== uid) { const n = userById.get(id).name; peers.push({ ...profile(userById.get(id)), keep: keep.has(n) }); io.to(s).emit('room:rejoined', { name: me.name, keep: keep.has(n) }); }
      connLog('room-resume', socket);
      socket.emit('room:peers', peers);
      return pushRoom();
    }
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
    lives.set(uid, { sock: socket.id, viewers: new Map() }); liveNoteOn(uid);
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

  // ----- v0.9：群聊歌单 -----
  socket.emit('music', musicState());
  const ack = (cb, v) => { if (typeof cb === 'function') cb(v); };
  socket.on('music:ping', (_, cb) => ack(cb, Date.now()));   // 对时：客户端据此算出和服务器的时间差
  socket.on('music:add', (id, cb) => { const e = plAdd(userById.get(uid), id); ack(cb, e ? { error: e } : { ok: true }); });
  // v0.10：网易云
  socket.on('music:addne', async (id, cb) => {   // v0.20：id 或 { id, own: true }（own = 我自己的网易云账号能放这首）
    const o = id && typeof id === 'object' ? id : { id };
    const e = await plAddNe(userById.get(uid), o.id, o.own === true); ack(cb, e ? { error: e } : { ok: true });
  });
  const neCur = qid => { const c = PL.cur; return c && c.ne && c.qid === parseInt(qid) ? c : null; };
  socket.on('music:try', qid => { const c = neCur(qid); if (c) c.ne.tries.add(socket.id); });
  socket.on('music:ok', qid => { const c = neCur(qid); if (c) { c.ne.ok = true; c.ne.oks.add(socket.id); c.ne.fails.delete(socket.id); clearTimeout(c.ne.fail); clearTimeout(c.watch); } });
  const neOkNow = c => { for (const id of c.ne.oks) if (!io.sockets.sockets.has(id)) c.ne.oks.delete(id); c.ne.ok = c.ne.oks.size > 0; return c.ne.ok; };   // 放得了的人退出 / 换了没会员的账号：重新算
  // v0.20：只有“所有试着放的人都放不了”（地区 / 版权 / 需要会员）才替大家跳过；有会员的人还在加载就继续等
  const neAllFailed = c => [...c.ne.tries].every(id => c.ne.fails.has(id) || !io.sockets.sockets.has(id));
  const neCheck = c => { clearTimeout(c.ne.fail); c.ne.fail = setTimeout(() => { if (PL.cur === c && !neOkNow(c) && neAllFailed(c)) neSkip(c.qid, 'error'); }, NE_FAIL_GRACE); };
  socket.on('music:fail', (qid, why, cb) => {
    if (typeof why === 'function') { cb = why; why = ''; }
    const c = neCur(qid); if (!c) return ack(cb, { gone: true });
    c.ne.tries.add(socket.id); c.ne.fails.add(socket.id); c.ne.oks.delete(socket.id);
    if (neOkNow(c)) return ack(cb, { kept: true });   // 别人放得了：只有你这里放不了，不替大家跳过
    if (!neAllFailed(c)) return ack(cb, { waiting: true });   // 还有人在加载（比如有会员的人），先等
    neCheck(c); ack(cb, { skipping: true });
  });
  socket.on('music:remove', (qid, cb) => {
    const r = db.prepare('SELECT * FROM playlist WHERE qid=?').get(parseInt(qid) || 0), u = userById.get(uid);
    if (!r) return ack(cb, { error: '这首歌已经不在歌单里了' });
    if (r.user_id !== uid && !u.is_admin) return ack(cb, { error: '只能移除自己点的歌' });
    plRemove(r.qid); ack(cb, { ok: true });
  });
  socket.on('music:ctl', (m, cb) => { m = m || {}; const e = plCtl(userById.get(uid), m.qid, String(m.op || ''), m.t); ack(cb, e ? { error: e } : { ok: true }); });
  socket.on('music:skip', (qid, cb) => {
    const u = userById.get(uid), cur = PL.cur && db.prepare('SELECT * FROM playlist WHERE qid=?').get(PL.cur.qid);
    if (!cur || (qid && cur.qid !== parseInt(qid))) return ack(cb, { error: '这首歌已经播完了' });
    if (!u.is_admin && cur.user_id !== uid && !groupSettings().skip) return ack(cb, { error: '管理员没有开放切歌' });
    plNext(cur.qid); ack(cb, { ok: true });
  });

  socket.on('disconnect', reason => {
    connLog('disconnect', socket, reason);
    { const c = PL.cur; if (c && c.ne && c.ne.tries.has(socket.id)) { c.ne.tries.delete(socket.id); c.ne.fails.delete(socket.id); c.ne.oks.delete(socket.id); if (!neOkNow(c) && c.ne.fails.size && neAllFailed(c)) neCheck(c); } }
    online.delete(socket.id); onlineIds.delete(socket.id); pushOnline();
    const c = calls.get(uid);
    const dropped = reason !== 'client namespace disconnect' && reason !== 'server namespace disconnect';   // 主动退出 / 被踢：立刻结束
    if (c && c.state === 'active' && c.sock === socket.id && dropped) {
      clearTimeout(callGrace.get(uid));
      callGrace.set(uid, setTimeout(() => { callGrace.delete(uid); const k = calls.get(uid); if (k && k.sock === socket.id) endCall(uid, 'offline'); }, VOICE_GRACE_MS));
    } else if (c && (c.sock === socket.id || (!c.sock && !socketsOf(uid).length))) endCall(uid, c.state === 'active' ? 'hangup' : 'offline');
    if (room.get(uid) === socket.id && dropped) {
      clearTimeout(roomGrace.get(uid));
      roomGrace.set(uid, setTimeout(() => { roomGrace.delete(uid); leaveRoom(uid, socket.id); }, VOICE_GRACE_MS));
    } else leaveRoom(uid, socket.id);
    if (lives.get(uid)?.sock === socket.id) endLive(uid, true);   // 断线：多等一会儿，重连后继续共享就不发“结束”
    for (const L of lives.values()) leaveLive(socket.id, uid, L);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Hush v' + VERSION + ' 已启动：http://localhost:' + PORT);
  console.log(WEB_CHAT ? '注意：WEB_CHAT=1，网页版也能聊天（临时模式）' : '只有 Hush 桌面版能聊天；网页只能登录 / 注册 / 看个人信息');
  if (turnConf()) { console.log('已配置 Cloudflare TURN（语音 / 直播打不通时自动中转）'); iceFor(); }
});
