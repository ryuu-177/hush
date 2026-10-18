/* 液态玻璃外观设置（Hush 与 To Writing Studio 共用）
 * - 三个预设：通透 / 标准 / 磨砂，外加“透明度”“模糊”两个滑杆，实时生效
 * - 只保存在本机浏览器（localStorage: lq_glass_v1），不上传，不影响别人
 * - 通过三个 CSS 变量起作用：--lq-ta（玻璃透明系数）、--lq-tf（实色填充）、--lq-bk（模糊倍数）
 */
(function () {
  var KEY = 'lq_glass_v1';
  var PRESETS = { clear: { clear: 85, blur: 38 }, std: { clear: 50, blur: 50 }, frost: { clear: 14, blur: 78 } };
  var st = { mode: 'std', clear: 50, blur: 50 };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved) st = Object.assign(st, saved); } catch (e) {}

  function apply() {
    var s = Math.max(0, Math.min(100, +st.clear || 0)), b = Math.max(0, Math.min(100, +st.blur || 0));
    var ta = s <= 50 ? 1 : 1 - (s - 50) / 50 * 0.75;
    var tf = s < 50 ? (50 - s) / 50 : 0;
    var r = document.documentElement;
    r.style.setProperty('--lq-ta', ta.toFixed(3));
    r.style.setProperty('--lq-tf', tf.toFixed(3));
    r.style.setProperty('--lq-bk', (b / 50).toFixed(3));
    r.setAttribute('data-glass', st.mode);
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  apply();

  var CSS = [
    '.lqg{--lqg-fg:var(--ef-tx1,var(--tx-1,#1c2923));--lqg-mut:var(--ef-tx3,var(--tx-3,#6c7c70));--lqg-line:var(--lq-line,rgba(0,0,0,.12));display:flex;flex-direction:column;gap:14px;padding:16px;border-radius:22px;background:var(--lq-glass);border:1px solid var(--lq-edge);box-shadow:inset 0 1px 0 var(--lq-spec),0 0 0 .5px var(--lqg-line);color:var(--lqg-fg);text-align:left}',
    '.lqg-head{display:flex;align-items:baseline;gap:10px}',
    '.lqg-head b{font-size:15px;font-weight:700;letter-spacing:.04em}',
    '.lqg-k{font:700 9.5px var(--mono,monospace);letter-spacing:.22em;color:var(--lqg-mut)}',
    '.lqg-reset{margin-left:auto;font-size:11.5px!important;padding:5px 12px!important;min-height:0!important}',
    '.lqg-prev{position:relative;height:118px;border-radius:18px;overflow:hidden;background-color:var(--ef-bg1,var(--bg-1));background-image:var(--lq-bp);background-size:820px auto;background-position:-120px -90px;border:1px solid var(--lqg-line)}',
    '.lqg-prev::after{content:"";position:absolute;inset:0;background:radial-gradient(60% 80% at 80% 20%,rgba(217,232,79,.35),transparent 70%);pointer-events:none}',
    '.lqg-bub{position:absolute;z-index:1;left:14px;top:16px;max-width:62%;padding:9px 14px;border-radius:6px 18px 18px 18px;font-size:13px;background:var(--lq-bubble);border:1px solid var(--lq-edge);-webkit-backdrop-filter:blur(calc(18px*var(--lq-bk,1))) saturate(1.8);backdrop-filter:blur(calc(18px*var(--lq-bk,1))) saturate(1.8);box-shadow:inset 0 1px 0 var(--lq-spec),0 0 0 .5px var(--lqg-line)}',
    '.lqg-own{left:auto;right:14px;top:auto;bottom:16px;border-radius:18px 6px 18px 18px;background:var(--lq-bubble-own)}',
    '.lqg-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;border-radius:999px;background:color-mix(in srgb,var(--lqg-fg) 6%,transparent);border:1px solid var(--lqg-line)}',
    '.lqg-seg button{display:flex!important;flex-direction:column;align-items:center;gap:3px;padding:8px 4px!important;border-radius:999px!important;background:transparent!important;background-image:none!important;border:1px solid transparent!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;color:var(--lqg-mut)!important;font-size:12.5px!important;letter-spacing:.06em}',
    '.lqg-seg button i{width:22px;height:22px;border-radius:50%;border:1px solid var(--lqg-line);display:block}',
    '.lqg-seg button[data-m="clear"] i{background:linear-gradient(135deg,rgba(255,255,255,.55),rgba(255,255,255,.08))}',
    '.lqg-seg button[data-m="std"] i{background:linear-gradient(135deg,rgba(255,255,255,.85),rgba(255,255,255,.35))}',
    '.lqg-seg button[data-m="frost"] i{background:linear-gradient(135deg,#f4f3eb,#d8ddd0)}',
    '.lqg-seg button.on{background:var(--lq-glass-h)!important;border-color:var(--lq-edge)!important;color:var(--lqg-fg)!important;box-shadow:inset 0 1px 0 var(--lq-spec),0 0 0 .5px var(--lqg-line),0 6px 16px -10px rgba(0,0,0,.4)!important}',
    '.lqg-row{display:flex;flex-direction:column;gap:6px}',
    '.lqg-row label{display:flex;justify-content:space-between;font-size:12px;color:var(--lqg-mut);letter-spacing:.06em}',
    '.lqg-row label b{color:var(--lqg-fg);font-weight:600;font-variant-numeric:tabular-nums}',
    '.lqg-rg{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--lqg-mut)}',
    '.lqg input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:28px;margin:0;background:transparent!important;border:0!important;box-shadow:none!important;padding:0!important;--p:50%}',
    '.lqg input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:linear-gradient(90deg,var(--ac,#d9e84f) var(--p),color-mix(in srgb,var(--lqg-fg) 14%,transparent) var(--p))}',
    '.lqg input[type=range]::-moz-range-track{height:6px;border-radius:3px;background:color-mix(in srgb,var(--lqg-fg) 14%,transparent)}',
    '.lqg input[type=range]::-moz-range-progress{height:6px;border-radius:3px;background:var(--ac,#d9e84f)}',
    '.lqg input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:26px;height:26px;margin-top:-10px;border-radius:50%;background:linear-gradient(180deg,#fff,#eef0ea);border:.5px solid rgba(0,0,0,.12);box-shadow:0 2px 6px rgba(0,0,0,.22),0 0 0 3px rgba(255,255,255,.35);transition:transform .35s var(--lq-spring,ease)}',
    '.lqg input[type=range]:active::-webkit-slider-thumb{transform:scale(1.15)}',
    '.lqg input[type=range]::-moz-range-thumb{width:24px;height:24px;border-radius:50%;background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 2px 6px rgba(0,0,0,.22)}',
    '.lqg-note{margin:0;font-size:11px;color:var(--lqg-mut);line-height:1.6}'
  ].join('\n');

  function mount(host, before) {
    if (!host || host.querySelector('.lqg')) return;
    if (!document.getElementById('lqg-style')) { var s = document.createElement('style'); s.id = 'lqg-style'; s.textContent = CSS; document.head.appendChild(s); }
    var el = document.createElement('div');
    el.className = 'lqg';
    el.innerHTML =
      '<div class="lqg-head"><span class="lqg-k">APPEARANCE</span><b>液态玻璃</b><button type="button" class="lqg-reset">恢复默认</button></div>' +
      '<div class="lqg-prev" aria-hidden="true"><div class="lqg-bub">透过玻璃看图纸</div><div class="lqg-bub lqg-own">这是我的消息</div></div>' +
      '<div class="lqg-seg" role="radiogroup" aria-label="玻璃风格">' +
        '<button type="button" role="radio" data-m="clear"><i></i>通透</button>' +
        '<button type="button" role="radio" data-m="std"><i></i>标准</button>' +
        '<button type="button" role="radio" data-m="frost"><i></i>磨砂</button></div>' +
      '<div class="lqg-row"><label for="lqgClear">透明度 <b class="v1"></b></label><div class="lqg-rg"><span>实色</span><input type="range" id="lqgClear" min="0" max="100" step="1"><span>通透</span></div></div>' +
      '<div class="lqg-row"><label for="lqgBlur">背景模糊 <b class="v2"></b></label><div class="lqg-rg"><span>清晰</span><input type="range" id="lqgBlur" min="0" max="100" step="1"><span>柔和</span></div></div>' +
      '<p class="lqg-note">只影响这台设备上的显示，随时可以改回来。</p>';
    if (before && before.parentNode === host) host.insertBefore(el, before); else host.appendChild(el);
    var r1 = el.querySelector('#lqgClear'), r2 = el.querySelector('#lqgBlur');
    function paint() {
      r1.value = st.clear; r2.value = st.blur;
      r1.style.setProperty('--p', st.clear + '%'); r2.style.setProperty('--p', st.blur + '%');
      el.querySelector('.v1').textContent = st.clear + '%';
      el.querySelector('.v2').textContent = st.blur + '%';
      el.querySelectorAll('.lqg-seg button').forEach(function (b) { var on = b.dataset.m === st.mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    }
    function matchMode() { st.mode = 'custom'; for (var k in PRESETS) if (PRESETS[k].clear == st.clear && PRESETS[k].blur == st.blur) st.mode = k; }
    el.querySelectorAll('.lqg-seg button').forEach(function (b) {
      b.addEventListener('click', function () { var p = PRESETS[b.dataset.m]; st.mode = b.dataset.m; st.clear = p.clear; st.blur = p.blur; apply(); save(); paint(); });
    });
    r1.addEventListener('input', function () { st.clear = +r1.value; matchMode(); apply(); paint(); });
    r2.addEventListener('input', function () { st.blur = +r2.value; matchMode(); apply(); paint(); });
    r1.addEventListener('change', save); r2.addEventListener('change', save);
    el.querySelector('.lqg-reset').addEventListener('click', function () { st = { mode: 'std', clear: 50, blur: 50 }; apply(); save(); paint(); });
    paint();
  }
  window.LQGlass = { mount: mount, apply: apply };
  function auto() {
    var h = document.querySelector('#setv .body');                       // Hush · 设置
    if (h) mount(h, h.querySelector('.srow.out'));
    var c = document.querySelector('#v-cfg .cfg-body');                  // To Writing Studio · 系统配置
    if (c) { var sec = document.createElement('div'); sec.className = 'cfg-sec lqg-sec'; c.insertBefore(sec, c.firstChild); mount(sec); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto); else auto();
})();
