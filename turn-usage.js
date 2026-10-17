// Hush：查询本月 Cloudflare TURN 流量，快到免费额度时提醒（v0.11.1）
// 用法：node turn-usage.js
// 需要：Cloudflare 账户 ID + 一个有 “Account → Account Analytics → Read” 权限的 API 令牌
//      （注意：这不是 turn.json 里的 TURN 密钥令牌，要在 Cloudflare 面板 “Account API tokens” 另外创建）
// 放在环境变量 CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN，或写进 turn.json：{"keyId":"...","apiToken":"...","accountId":"...","analyticsToken":"..."}
// 计费：每月前 1000 GB 出站流量免费（SFU 和 TURN 共用），之后 $0.05/GB。只算 egressBytes（Cloudflare 发给用户的流量）。
// 结果：正常退出码 0；超过提醒线（默认 80%，可用 TURN_WARN_PCT 改）退出码 2；查询失败退出码 1。可以用 Windows 任务计划每天跑一次。
const fs = require('fs'), path = require('path');
let j = {};
try { j = JSON.parse(fs.readFileSync(path.join(__dirname, 'turn.json'), 'utf8')); } catch (e) {}
const ACCOUNT = process.env.CF_ACCOUNT_ID || j.accountId;
const TOKEN = process.env.CF_ANALYTICS_TOKEN || j.analyticsToken;
const KEY = process.env.CF_TURN_KEY_ID || j.keyId;   // 只统计这把 TURN 密钥（没有就统计整个账户）
const API = (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
const FREE_GB = 1000, PRICE = 0.05, WARN = Number(process.env.TURN_WARN_PCT) || 80;
if (!ACCOUNT || !TOKEN) {
  console.error('缺少 CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN（或 turn.json 里的 accountId / analyticsToken）');
  process.exit(1);
}
const now = new Date(), d = n => n.toISOString().slice(0, 10);
const from = d(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to = d(now);
const query = `query ($acc: String!, $from: Date!, $to: Date!${KEY ? ', $key: String!' : ''}) {
  viewer { accounts(filter: { accountTag: $acc }) {
    callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $from, date_leq: $to${KEY ? ', keyId: $key' : ''} }) {
      sum { egressBytes ingressBytes }
    }
  } }
}`;
(async () => {
  const r = await fetch(API + '/graphql', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { acc: ACCOUNT, from, to, ...(KEY ? { key: KEY } : {}) } }), signal: AbortSignal.timeout(20000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || (body.errors && body.errors.length)) {
    console.error('查询失败：HTTP ' + r.status + ' ' + JSON.stringify((body && body.errors) || body).slice(0, 300));
    process.exit(1);
  }
  const rows = (body.data.viewer.accounts[0] || {}).callsTurnUsageAdaptiveGroups || [];
  const eg = rows.reduce((a, x) => a + (x.sum.egressBytes || 0), 0), ing = rows.reduce((a, x) => a + (x.sum.ingressBytes || 0), 0);
  const gb = eg / 1e9, pct = gb / FREE_GB * 100;
  const day = now.getUTCDate() - 1 + (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const proj = day > 0.5 ? gb / day * days : null;
  console.log(`本月（${from} 起，UTC）TURN 出站流量：${gb.toFixed(2)} GB / 免费 ${FREE_GB} GB（${pct.toFixed(1)}%）；入站 ${(ing / 1e9).toFixed(2)} GB（不收费）`);
  if (proj != null) console.log(`按目前速度，月底约 ${proj.toFixed(1)} GB` + (proj > FREE_GB ? `，预计超出 ${(proj - FREE_GB).toFixed(1)} GB ≈ $${((proj - FREE_GB) * PRICE).toFixed(2)}` : '，在免费额度内'));
  if (gb > FREE_GB) { console.log(`⚠ 已超出免费额度，超出部分 ≈ $${((gb - FREE_GB) * PRICE).toFixed(2)}`); process.exit(2); }
  if (pct >= WARN) { console.log(`⚠ 已用到免费额度的 ${pct.toFixed(0)}%（提醒线 ${WARN}%）`); process.exit(2); }
})().catch(e => { console.error('查询失败：' + e.message); process.exit(1); });
