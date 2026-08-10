/* 画布视图 — 无限画布 + 贴在上面的会话终端
 *
 * 与列表视图的根本差别:tile 上不放 live xterm。画布靠 CSS transform 缩放,
 * 而 xterm 的 canvas/WebGL 渲染在 transform 下会糊、鼠标坐标与选区会错位。
 * 所以 tile 只贴服务端推来的原样屏幕 HTML(纯 DOM 文本,缩放无损),
 * live xterm 只在展开层出现,且展开层不参与画布 transform。
 *
 * 依赖 app.js 提供的全局:state / STATUS / esc / ago / dirTail / $ /
 * WS_BASE / wsProto / act / toast。
 */
'use strict';

(function () {
  const KEY = 'ccw.canvas.v1';
  const CH = 7;      // 等宽字符宽度(px),tile 宽度按它吸附
  const LH = 15;     // tail 行高(px),tile 高度按它吸附
  const HDR = 26, FTR = 18;
  const MIN_W = 140, MIN_H = HDR + FTR + 3 * LH;
  const Z_MIN = 0.1, Z_MAX = 2.4;
  // 注意力权重:>=2 视为"在等你",决定描边、呼吸、屏外指示、N 键顺序
  const ATTN = { needs_permission: 4, needs_decision: 3, blocked: 2, review_ready: 1 };
  // tile 默认按 PTY 实际分辨率开,否则 120 列的 TUI 塞进 45 列的 tile 必然显示不全
  const TAIL_PAD = 20, CHROME = HDR + FTR + 8;
  const wForCols = (c) => Math.round(c * CH) + TAIL_PAD;
  const hForRows = (r) => r * LH + CHROME;
  const DEF_W = wForCols(120), DEF_H = hForRows(32);

  const CV = {
    view: { tx: 60, ty: 40, z: 0.86 },
    geo: {},            // id -> {x,y,w,h}
    sel: [],
    expanded: null,
    coachDone: false,
    space: false, panning: false, dragging: false,
    marquee: null,
    scroll: {},         // id -> 向上回看的行数(tail 只有 14 行,见 tailRows)
    els: new Map(),     // id -> { root, ... }
    tier: new Map(),    // id -> 上次应用的 LOD 层级
    laneMode: false,   // 开启后 tile 位置由状态决定,状态一变就自动归位
    lastStatus: new Map(), // id -> 上次见到的状态,用于发现"换区了"
    mounted: false,
    dom: null,
    term: null, termWs: null, termFit: null, termRO: null, termCtl: false,
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const attnOf = (s) => ATTN[s.status] || 0;
  const isAttn = (s) => attnOf(s) >= 2;
  const isDim = (s) => s.status === 'completed' || s.status === 'exited';
  const stColor = (s) => `var(--c-${s.status || 'ready'})`;

  /* ---------- 持久化 ---------- */
  function load() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* 坏数据按默认 */ }
    if (raw.view && typeof raw.view.z === 'number') {
      CV.view = { tx: +raw.view.tx || 0, ty: +raw.view.ty || 0, z: clamp(+raw.view.z || 1, Z_MIN, Z_MAX) };
    }
    if (raw.geo && typeof raw.geo === 'object') CV.geo = raw.geo;
    CV.coachDone = !!raw.coachDone;
    CV.laneMode = !!raw.laneMode;
  }
  let saveTimer = null;
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify({
        view: CV.view, geo: CV.geo, coachDone: CV.coachDone, laneMode: CV.laneMode,
      }));
    } catch { /* 隐私模式下不持久化 */ }
  }
  // 拖拽/平移会高频调用,合并写盘;但关页面时必须立刻落盘,否则最后一次拖动白做
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 250);
  }
  window.addEventListener('pagehide', () => { if (saveTimer) flush(); });

  /* ---------- 会话 → tile ---------- */
  function sessions() {
    return [...state.sessions.values()].filter((s) => !s.archived);
  }
  // 新会话自动找一个不重叠的位置:按行扫描,避开已占格子。
  // 初始尺寸取该会话 PTY 的实际分辨率,保证一上来就能完整渲染 TUI。
  function place(id) {
    const s = state.sessions.get(id);
    const w = s && s.ptyCols ? wForCols(s.ptyCols) : DEF_W;
    const h = s && s.ptyRows ? hForRows(s.ptyRows) : DEF_H;
    const taken = Object.entries(CV.geo).filter(([k]) => k !== id).map(([, g]) => g);
    const GAP = 22;
    for (let row = 0; row < 40; row++) {
      for (let col = 0; col < 6; col++) {
        const x = col * (w + GAP), y = row * (h + GAP);
        const hit = taken.some((g) => x < g.x + g.w + GAP && x + w + GAP > g.x
          && y < g.y + g.h + GAP && y + h + GAP > g.y);
        if (!hit) return { x, y, w, h };
      }
    }
    return { x: 0, y: 0, w, h };
  }
  function geoOf(id) {
    if (!CV.geo[id]) { CV.geo[id] = place(id); save(); }
    return CV.geo[id];
  }
  function attnList() {
    return sessions().filter(isAttn).sort((a, b) => {
      const d = attnOf(b) - attnOf(a);
      if (d) return d;
      const ga = geoOf(a.id), gb = geoOf(b.id);
      return (ga.y - gb.y) || (ga.x - gb.x);
    });
  }
  // tile 能显示多少行 —— 同时也是松手后同步给 PTY 的行数
  function tailRows(g) { return Math.max(1, Math.floor((g.h - HDR - FTR - 8) / LH)); }

  /* ---------- 骨架 ---------- */
  const HTML = `
<div class="cv-bar">
  <div class="cv-zoom">
    <button id="cv-zo" title="缩小">−</button>
    <button id="cv-zr" title="回到 100%(键 1)"><span id="cv-pct">86%</span></button>
    <button id="cv-zi" title="放大">+</button>
  </div>
  <button class="cv-btn" id="cv-fit" title="全览(键 0)">全览</button>
  <div class="cv-sizes">
    <span>尺寸</span>
    <button data-sz="s" title="80×24">小</button>
    <button data-sz="m" title="120×32">中</button>
    <button data-sz="l" title="160×48">大</button>
    <input id="cv-sz-in" value="120×32" title="自定义 列×行" spellcheck="false">
    <button id="cv-sz-all" title="把这个尺寸套用到所有会话">全部应用</button>
  </div>
  <button class="cv-btn" id="cv-tidy" title="按状态自动分区(键 G):状态变化时 tile 会自动移到对应区域">自动分区</button>
  <button class="cv-btn" id="cv-sweep" title="淡出已完成 / 已退出的会话">清理</button>
  <div class="cv-spacer"></div>
  <button class="cv-attn" id="cv-attn" title="跳到下一个需要你的会话(键 N)">
    <span class="cv-attn-dot"></span><span id="cv-attn-txt">无人等你</span><kbd>N</kbd>
  </button>
</div>
<div class="cv-vp" id="cv-vp">
  <div class="cv-world" id="cv-world"></div>
  <div class="cv-marquee" id="cv-mq" hidden></div>
  <div class="cv-edges" id="cv-edges"></div>
  <div class="cv-map" id="cv-map" title="点击跳转视口">
    <div class="cv-map-label">MINIMAP</div>
    <div class="cv-map-dots" id="cv-map-dots"></div>
    <div class="cv-map-vp" id="cv-map-vp"></div>
  </div>
  <div class="cv-hud">
    <span id="cv-mode">画布</span><i></i>
    <span>滚轮 平移</span>·<span>⌘/Ctrl+滚轮 缩放</span>·<span>空格拖拽 平移</span>·<span>空白拖拽 框选</span>
    ·<span>单击 选中 / 双击 展开</span><i></i>
    <button class="cv-link" id="cv-help">全部手势 ?</button>
  </div>
  <div class="cv-expand" id="cv-expand" hidden></div>
  <div class="cv-coach" id="cv-coach" hidden></div>
</div>`;

  const COACH = `
<div class="cv-coach-card">
  <div class="cv-coach-h"><span class="cv-coach-dot"></span>画布视图 · 手势分工</div>
  <div class="cv-coach-sub">画布是 Inbox 的补充,不是替代。需要你的会话永远优先。</div>
  <dl class="cv-coach-kv">
    <dt>滚轮 / 触控板</dt><dd>平移画布(Shift 切横向)</dd>
    <dt>⌘/Ctrl + 滚轮</dt><dd>以光标为锚缩放;触控板双指捏合同效</dd>
    <dt>空白处拖拽</dt><dd>框选多个 tile</dd>
    <dt>空格 / 中键拖拽</dt><dd>平移,任何位置都生效</dd>
    <dt>单击 tile</dt><dd>选中并聚焦 —— 琥珀描边;此后滚轮在该 tile 上 = 回看 tail</dd>
    <dt>双击 / ⤢</dt><dd>展开为可输入的真实终端(live xterm 只在这时存在)</dd>
    <dt>拖角 / 拖边</dt><dd>改尺寸,松手后终端按新分辨率重排(所有观察者同步)</dd>
    <dt>N</dt><dd>跳到下一个需要你的会话</dd>
    <dt>G</dt><dd>自动分区:按状态归位,状态一变自动移到对应区域;拖动即退出</dd>
    <dt>0 / 1</dt><dd>全览 / 回到 100%</dd>
    <dt>Esc</dt><dd>收起展开态 · 取消选中</dd>
  </dl>
  <div class="cv-coach-act"><button class="btn-primary" id="cv-coach-ok">开始 ↵</button></div>
</div>`;

  /* ---------- 挂载 ---------- */
  function mount(host) {
    load();
    host.innerHTML = HTML;
    CV.dom = {
      vp: $('#cv-vp'), world: $('#cv-world'), mq: $('#cv-mq'), edges: $('#cv-edges'),
      map: $('#cv-map'), mapDots: $('#cv-map-dots'), mapVp: $('#cv-map-vp'),
      pct: $('#cv-pct'), attn: $('#cv-attn'), attnTxt: $('#cv-attn-txt'),
      mode: $('#cv-mode'), expand: $('#cv-expand'), coach: $('#cv-coach'),
    };
    CV.els.clear(); CV.tier.clear();
    CV.mounted = true;

    $('#cv-zi').onclick = () => zoomAt(1.25);
    $('#cv-zo').onclick = () => zoomAt(0.8);
    $('#cv-zr').onclick = () => zoomTo(1);
    $('#cv-fit').onclick = fitAll;
    CV.dom.szIn = $('#cv-sz-in');
    document.querySelectorAll('.cv-sizes [data-sz]').forEach((b) => {
      b.onclick = () => {
        const p = SIZES.find((x) => x.k === b.dataset.sz);
        CV.dom.szIn.value = `${p.cols}×${p.rows}`;
        applyAll(p.cols, p.rows);
      };
    });
    $('#cv-sz-all').onclick = () => {
      const d = parseSize(CV.dom.szIn.value);
      if (!d) { toast('尺寸格式不对', '写成「列×行」,例如 120×32', null, 3000); return; }
      applyAll(d.cols, d.rows);
    };
    CV.dom.szIn.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') $('#cv-sz-all').click(); };
    CV.dom.tidy = $('#cv-tidy');
    CV.dom.tidy.onclick = () => (CV.laneMode ? setLaneMode(false) : tidy());
    $('#cv-sweep').onclick = sweep;
    $('#cv-attn').onclick = nextAttention;
    $('#cv-help').onclick = () => showCoach(true);

    CV.dom.vp.addEventListener('wheel', onWheel, { passive: false });
    CV.dom.vp.addEventListener('mousedown', onVpDown);
    CV.dom.map.addEventListener('mousedown', onMapDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    CV.ro = new ResizeObserver(() => { paintEdges(); paintMap(); });
    CV.ro.observe(CV.dom.vp);

    if (!CV.coachDone) showCoach(false);
    syncTiles();
    if (CV.laneMode) setLaneMode(true, true); // 恢复上次的分区状态,不再弹提示
    applyView();
  }

  function dispose() {
    if (!CV.mounted) return;
    closePtyMenu();
    closeStatusMenu();
    closeExpand(true);
    CV.dom.vp.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    if (CV.ro) CV.ro.disconnect();
    clearInterval(CV.tween);
    clearTimeout(relayoutTimer); relayoutTimer = null;
    CV.mounted = false; CV.dom = null;
    CV.els.clear(); CV.tier.clear();
  }

  /* ---------- 视图变换 ---------- */
  // 平移只写一次 transform + 背景位置,不碰任何 tile —— 拖动才跟手
  function applyView(zoomChanged) {
    const { tx, ty, z } = CV.view, d = CV.dom;
    if (!d) return;
    d.world.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${z})`;
    d.vp.style.backgroundSize = `${Math.max(6, 80 * z)}px ${Math.max(6, 80 * z)}px,${Math.max(3, 16 * z)}px ${Math.max(3, 16 * z)}px`;
    d.vp.style.backgroundPosition = `${tx}px ${ty}px,${tx}px ${ty}px`;
    d.pct.textContent = Math.round(z * 100) + '%';
    if (zoomChanged !== false) { for (const s of sessions()) applyTier(s); }
    paintEdges();
    paintMap();
  }
  function setView(v, zoomChanged) { CV.view = v; applyView(zoomChanged); save(); }
  function vpSize() {
    const r = CV.dom.vp.getBoundingClientRect();
    return { w: r.width || 1200, h: r.height || 700 };
  }
  function tween(to, ms) {
    const from = { ...CV.view }, t0 = Date.now();
    ms = ms || 340;
    clearInterval(CV.tween);
    CV.tween = setInterval(() => {
      const k = clamp((Date.now() - t0) / ms, 0, 1), e = 1 - Math.pow(1 - k, 3);
      CV.view = {
        tx: from.tx + (to.tx - from.tx) * e,
        ty: from.ty + (to.ty - from.ty) * e,
        z: from.z + (to.z - from.z) * e,
      };
      applyView();
      if (k >= 1) { clearInterval(CV.tween); save(); }
    }, 16);
  }
  function zoomAt(f) {
    const V = CV.view, vp = vpSize(), z2 = clamp(V.z * f, Z_MIN, Z_MAX);
    tween({ z: z2, tx: vp.w / 2 - (vp.w / 2 - V.tx) * (z2 / V.z), ty: vp.h / 2 - (vp.h / 2 - V.ty) * (z2 / V.z) }, 180);
  }
  function zoomTo(z2) {
    const V = CV.view, vp = vpSize();
    tween({ z: z2, tx: vp.w / 2 - (vp.w / 2 - V.tx) * (z2 / V.z), ty: vp.h / 2 - (vp.h / 2 - V.ty) * (z2 / V.z) }, 220);
  }
  function fitAll() {
    const L = sessions(); if (!L.length) return;
    const G = L.map((s) => geoOf(s.id));
    const x0 = Math.min(...G.map((g) => g.x)), y0 = Math.min(...G.map((g) => g.y));
    const x1 = Math.max(...G.map((g) => g.x + g.w)), y1 = Math.max(...G.map((g) => g.y + g.h));
    const vp = vpSize(), pad = 70;
    const z = clamp(Math.min((vp.w - pad * 2) / Math.max(1, x1 - x0), (vp.h - pad * 2) / Math.max(1, y1 - y0)), Z_MIN, 1.2);
    tween({ z, tx: vp.w / 2 - (x0 + x1) / 2 * z, ty: vp.h / 2 - (y0 + y1) / 2 * z });
  }
  function centerOn(id, zt) {
    const g = geoOf(id), z = zt || Math.max(CV.view.z, 0.8), vp = vpSize();
    tween({ z, tx: vp.w / 2 - (g.x + g.w / 2) * z, ty: vp.h / 2 - (g.y + g.h / 2) * z });
  }

  /* ---------- tile ---------- */
  function buildTile(s) {
    const el = document.createElement('div');
    el.className = 'cv-tile';
    el.dataset.id = s.id;
    el.innerHTML = `
      <div class="cv-rail"></div>
      <div class="cv-hd">
        <span class="cv-dot"></span>
        <span class="cv-nm"></span>
        <span class="cv-dir"></span>
        <span class="cv-st"></span>
        <button class="cv-exp" title="展开为可输入终端(双击 tile 亦可)">⤢</button>
      </div>
      <div class="cv-tailwrap"><pre class="cv-tail"></pre></div>
      <div class="cv-say"><span class="cv-say-p">❯</span><input class="cv-say-i" placeholder="输入后回车发送到这个会话"></div>
      <div class="cv-ft">
        <span class="cv-ago"></span>
        <button class="cv-pty" title="调整 PTY 分辨率(所有观察者同步重排)"></button>
        <span class="cv-grid"></span>
        <span class="cv-kind"></span>
      </div>
      <div class="cv-beacon"><span class="cv-bdot"></span><span class="cv-bnm"></span></div>
      <div class="cv-scrollhint"></div>
      <div class="cv-ghost">已展开 · 原位保留</div>
      <div class="cv-rz e"></div><div class="cv-rz s"></div><div class="cv-rz se"></div>`;
    const parts = {
      root: el,
      dot: el.querySelector('.cv-dot'), nm: el.querySelector('.cv-nm'), dir: el.querySelector('.cv-dir'),
      st: el.querySelector('.cv-st'), tail: el.querySelector('.cv-tail'),
      ago: el.querySelector('.cv-ago'), grid: el.querySelector('.cv-grid'), kind: el.querySelector('.cv-kind'),
      bnm: el.querySelector('.cv-bnm'), hint: el.querySelector('.cv-scrollhint'),
      pty: el.querySelector('.cv-pty'), say: el.querySelector('.cv-say-i'),
    };
    // 状态胶囊:点开手工设定菜单
    parts.st.addEventListener('mousedown', (e) => e.stopPropagation());
    parts.st.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = state.sessions.get(s.id);
      if (cur) openStatusMenu(parts.st, cur);
    });
    // 分辨率:点开步进器
    parts.pty.addEventListener('mousedown', (e) => e.stopPropagation());
    parts.pty.addEventListener('click', (e) => { e.stopPropagation(); openPtyMenu(parts.pty, s.id); });
    // 输入框:别让点击变成选中/拖拽,回车走 REST 直接写进 PTY
    parts.say.addEventListener('mousedown', (e) => e.stopPropagation());
    parts.say.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const text = parts.say.value.trim();
      if (!text) return;
      parts.say.value = '';
      api(`/api/sessions/${s.id}/input`, { text })
        .then((r) => toast(r.delivered ? '已发送' : '发送失败:session 未在运行', text, null, 2500))
        .catch((err) => toast('发送失败', err.message));
    });
    el.addEventListener('mousedown', (e) => onTileDown(s.id, e));
    el.addEventListener('dblclick', (e) => { e.preventDefault(); openExpand(s.id); });
    el.querySelector('.cv-exp').addEventListener('mousedown', (e) => {
      e.stopPropagation(); e.preventDefault(); openExpand(s.id);
    });
    el.querySelector('.cv-rz.e').addEventListener('mousedown', (e) => onResize(s.id, e, 'e'));
    el.querySelector('.cv-rz.s').addEventListener('mousedown', (e) => onResize(s.id, e, 's'));
    el.querySelector('.cv-rz.se').addEventListener('mousedown', (e) => onResize(s.id, e, 'se'));
    CV.els.set(s.id, parts);
    CV.dom.world.appendChild(el);
    return parts;
  }

  function applyGeo(id) {
    const p = CV.els.get(id); if (!p) return;
    const g = geoOf(id);
    p.root.style.transform = `translate3d(${g.x}px,${g.y}px,0)`;
    p.root.style.width = g.w + 'px';
    p.root.style.height = g.h + 'px';
  }

  // LOD:缩小时依次砍掉页脚、tail、头部,最后只剩一颗信号灯。
  // 同时把 chrome 尺寸按 1/z 反向放大,保证缩小后名字和状态灯仍然看得清。
  function applyTier(s) {
    const p = CV.els.get(s.id); if (!p) return;
    const z = CV.view.z, g = geoOf(s.id);
    let tier = z >= 0.55 ? 'full' : z >= 0.26 ? 'mid' : 'low';
    if (g.h < MIN_H + 6 && tier === 'full') tier = 'mid';
    if (z < 0.17) tier = 'pin';
    const prev = CV.tier.get(s.id);
    if (prev !== tier) {
      p.root.classList.remove('t-full', 't-mid', 't-low', 't-pin');
      p.root.classList.add('t-' + tier);
      CV.tier.set(s.id, tier);
    }
    if (tier === 'full' || tier === 'pin') {
      p.root.style.removeProperty('--cv-hdr');
      p.root.style.removeProperty('--cv-dot');
      p.root.style.removeProperty('--cv-pad');
      p.root.style.removeProperty('--cv-rail');
    } else {
      p.root.style.setProperty('--cv-hdr', clamp(10 / z, 10, Math.min(30, g.w / 8)) + 'px');
      p.root.style.setProperty('--cv-dot', clamp(8 / z, 7, Math.min(26, g.h * 0.3)) + 'px');
      p.root.style.setProperty('--cv-pad', clamp(5 / z, 4, 14) + 'px');
      p.root.style.setProperty('--cv-rail', clamp(3 / z, 3, 14) + 'px');
    }
    if (tier === 'low') {
      const bn = Math.min(11 / z, g.h * 0.5);
      p.root.style.setProperty('--cv-bnm', bn + 'px');
      p.root.style.setProperty('--cv-bdot', Math.min(9 / z, g.h * 0.52) + 'px');
      const maxCh = Math.max(2, Math.floor((g.w - 40) / (bn * 0.62)));
      p.bnm.textContent = s.name.length > maxCh ? s.name.slice(0, maxCh - 1) + '…' : s.name;
    }
  }

  function paintTile(s) {
    let p = CV.els.get(s.id);
    if (!p) { p = buildTile(s); applyGeo(s.id); }
    const g = geoOf(s.id), st = STATUS[s.status] || STATUS.ready;
    const attn = isAttn(s), sel = CV.sel.includes(s.id);

    p.root.style.setProperty('--cv-c', stColor(s));
    p.root.classList.toggle('attn', attn);
    p.root.classList.toggle('sel', sel);
    p.root.classList.toggle('dim', isDim(s));
    p.root.classList.toggle('ghost', CV.expanded === s.id);
    p.root.classList.toggle('live', !!s.alive && (s.status === 'executing' || s.status === 'verifying'));

    p.nm.textContent = s.name;
    p.dir.textContent = dirTail(s.projectDir);
    p.st.textContent = (s.statusOverride ? '✎ ' : '') + st.label;
    p.st.title = s.statusOverride ? '手工锁定中,点击可改或恢复自动' : '点击手工设定状态';
    p.root.classList.toggle('manual', !!s.statusOverride);
    p.ago.textContent = ago(s.lastActivityAt);
    p.kind.textContent = s.type === 'claude' ? (s.alive ? 'claude-code' : '已停止') : (s.alive ? 'terminal' : '已停止');
    // 列数对不上 = TUI 一定渲染错位(窗口窄了会被右侧裁掉,宽了则铺不满),标黄提示去匹配
    const show = { cols: Math.floor((g.w - TAIL_PAD) / CH), rows: tailRows(g) };
    const pc = s.ptyCols || 120, pr = s.ptyRows || 32;
    p.grid.textContent = `窗口 ${show.cols}×${show.rows}`;
    p.pty.textContent = `PTY ${pc}×${pr}`;
    const off = show.cols !== pc;
    p.pty.classList.toggle('mismatch', off);
    p.pty.title = off
      ? `窗口 ${show.cols} 列 ≠ PTY ${pc} 列,画面会错位。点这里匹配尺寸`
      : '调整 PTY 分辨率(所有观察者同步重排)';
    p.say.disabled = !s.alive;
    p.say.placeholder = s.alive ? '输入后回车发送到这个会话' : '会话未在运行';

    const back = CV.scroll[s.id] || 0;
    p.hint.textContent = back ? `⇅ 回看 −${back} 行` : '⇅ tail 底部';
    paintTail(s);
  }

  // 用原样视口(screenHtml)而不是清洗版 tail:清洗会砍掉边框、折叠空白,
  // Claude Code 这类全屏 TUI 经它一过就彻底错位。服务端已逐段转义,只含着色 span。
  // 容器 flex-end 底部对齐,超出部分从顶部裁掉 —— TUI 的输入框在底部,那里最要紧。
  function paintTail(s) {
    const p = CV.els.get(s.id); if (!p) return;
    const html = s.screenHtml !== undefined && s.screenHtml !== null ? s.screenHtml : s.tailHtml;
    const back = CV.scroll[s.id] || 0;
    if (html === undefined || html === null) {
      p.tail.textContent = s.tailCache || (s.alive ? '(等待画面…)' : '(未在运行)');
      return;
    }
    if (!back) { p.tail.innerHTML = html; return; }
    const lines = html.split('\n');
    p.tail.innerHTML = lines.slice(0, Math.max(1, lines.length - back)).join('\n');
  }

  // 会话增删 → 建/删 tile;其余只做增量刷新
  function syncTiles() {
    if (!CV.mounted) return;
    const live = new Set();
    let shifted = false; // 有 tile 需要换分区
    for (const s of sessions()) {
      live.add(s.id);
      if (CV.lastStatus.get(s.id) !== s.status) { CV.lastStatus.set(s.id, s.status); shifted = true; }
      paintTile(s); applyTier(s);
    }
    for (const [id, p] of CV.els) {
      if (live.has(id)) continue;
      p.root.remove();
      CV.els.delete(id); CV.tier.delete(id); CV.lastStatus.delete(id);
      shifted = true;
    }
    CV.sel = CV.sel.filter((id) => live.has(id));
    paintAttn();
    paintEdges();
    paintMap();
    if (shifted) scheduleRelayout();
  }

  function paintAttn() {
    const A = attnList();
    CV.dom.attn.classList.toggle('on', A.length > 0);
    CV.dom.attnTxt.textContent = A.length ? `${A.length} 个在等你` : '无人等你';
  }

  /* ---------- 尺寸 ---------- */
  // 拖完 tile 就把 PTY 一起改掉 —— 只改显示窗口的话,多出来的地方是空白、
  // 被压小的地方直接被裁掉,看上去就是"没有重新渲染"。
  const SIZES = [
    { k: 's', label: '小', cols: 80, rows: 24 },
    { k: 'm', label: '中', cols: 120, rows: 32 },
    { k: 'l', label: '大', cols: 160, rows: 48 },
  ];
  const colsOf = (g) => Math.max(40, Math.min(400, Math.floor((g.w - TAIL_PAD) / CH)));
  const rowsOf = (g) => Math.max(10, Math.min(200, tailRows(g)));
  function parseSize(v) {
    const m = String(v || '').match(/(\d+)\s*[×x*, ]\s*(\d+)/i);
    if (!m) return null;
    const cols = clamp(+m[1], 40, 400), rows = clamp(+m[2], 10, 200);
    return { cols, rows };
  }

  // 把 tile 调成给定分辨率并同步 PTY。会话没在跑就只调 tile。
  function sizeTo(id, cols, rows) {
    const g = geoOf(id);
    g.w = wForCols(cols); g.h = hForRows(rows);
    applyGeo(id);
    const s = state.sessions.get(id);
    if (s) { paintTile(s); applyTier(s); }
    if (!s || !s.alive) return Promise.resolve({ skipped: true });
    if ((s.ptyCols || 0) === cols && (s.ptyRows || 0) === rows) return Promise.resolve({ same: true });
    return act(id, 'resize', { cols, rows });
  }

  function applyAll(cols, rows) {
    const L = sessions();
    if (!L.length) return;
    for (const s of L) {
      const p = CV.els.get(s.id);
      if (p) { p.root.classList.add('anim'); setTimeout(() => p.root.classList.remove('anim'), 500); }
    }
    Promise.allSettled(L.map((s) => sizeTo(s.id, cols, rows))).then((rs) => {
      save(); paintMap();
      const bad = rs.filter((r) => r.status === 'rejected');
      if (bad.length) {
        toast('部分未生效', `${L.length - bad.length}/${L.length} 个会话已改为 ${cols}×${rows};${bad[0].reason.message}`, null, 6000);
      } else {
        toast('已全部应用', `${L.length} 个会话统一为 ${cols}×${rows}`, null, 3000);
      }
    });
  }

  // tile 上的尺寸菜单:三档预设 + 把当前 tile 尺寸推给所有人
  let ptyMenuEl = null;
  function closePtyMenu() { if (ptyMenuEl) { ptyMenuEl.remove(); ptyMenuEl = null; } }
  function openPtyMenu(anchor, id) {
    closePtyMenu();
    const s = state.sessions.get(id); if (!s) return;
    const g = geoOf(id);
    const cur = { cols: colsOf(g), rows: rowsOf(g) };

    const el = document.createElement('div');
    el.className = 'st-menu pty-menu';
    el.innerHTML = `
      <div class="st-menu-h">尺寸 · 当前 ${cur.cols}×${cur.rows}</div>
      ${SIZES.map((p) => `<button data-sz="${p.k}" class="${s.ptyCols === p.cols && s.ptyRows === p.rows ? 'on' : ''}">
        <i></i>${p.label}<em>${p.cols}×${p.rows}</em></button>`).join('')}
      <div class="st-menu-sep"></div>
      <button class="pty-apply" data-all="1">同步给所有会话 ${cur.cols}×${cur.rows}</button>
      <div class="st-menu-note">改尺寸会真正重排终端,所有正在观察这个会话的人画面都会跟着变。</div>`;
    document.body.appendChild(el);
    ptyMenuEl = el;

    el.querySelectorAll('[data-sz]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        closePtyMenu();
        const p = SIZES.find((x) => x.k === b.dataset.sz);
        sizeTo(id, p.cols, p.rows).then(() => { save(); paintMap(); })
          .catch((err) => toast('改尺寸失败', err.message, null, 5000));
      };
    });
    el.querySelector('[data-all]').onclick = (e) => {
      e.stopPropagation();
      closePtyMenu();
      if (CV.dom.szIn) CV.dom.szIn.value = `${cur.cols}×${cur.rows}`;
      applyAll(cur.cols, cur.rows);
    };

    const r = anchor.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 232)) + 'px';
    el.style.top = (r.bottom + 6 + el.offsetHeight > window.innerHeight - 8
      ? Math.max(8, r.top - el.offsetHeight - 6) : r.bottom + 6) + 'px';

    setTimeout(() => document.addEventListener('mousedown', function off(ev) {
      if (el.contains(ev.target)) { setTimeout(() => document.addEventListener('mousedown', off, { once: true }), 0); return; }
      closePtyMenu();
    }, { once: true }), 0);
  }

  /* ---------- 屏外注意力指示 ---------- */
  function paintEdges() {
    if (!CV.mounted) return;
    const { tx, ty, z } = CV.view, vp = vpSize();
    const out = [];
    for (const s of attnList()) {
      if (out.length >= 5) break;
      const g = geoOf(s.id);
      const l = g.x * z + tx, t = g.y * z + ty, r = l + g.w * z, b = t + g.h * z;
      if (r > 10 && l < vp.w - 10 && b > 10 && t < vp.h - 10) continue;
      const cx = (l + r) / 2, cy = (t + b) / 2;
      let arrow = '◀';
      if (cx > vp.w - 230) arrow = '▶';
      else if (cy < 58) arrow = '▲';
      else if (cy > vp.h - 98) arrow = '▼';
      out.push({ s, arrow, x: clamp(cx, 92, Math.max(92, vp.w - 230)), y: clamp(cy, 58, Math.max(58, vp.h - 98)) });
    }
    CV.dom.edges.innerHTML = out.map((o) => `
      <button class="cv-edge" data-id="${esc(o.s.id)}" style="left:${o.x}px;top:${o.y}px;--cv-c:${stColor(o.s)}">
        <span class="a">${o.arrow}</span><span class="n">${esc(o.s.name)}</span>
        <span class="s">${esc((STATUS[o.s.status] || {}).label || o.s.status)}</span>
      </button>`).join('');
    CV.dom.edges.querySelectorAll('.cv-edge').forEach((b) => {
      b.onclick = () => { select([b.dataset.id]); centerOn(b.dataset.id); };
    });
  }

  /* ---------- 小地图 ---------- */
  function paintMap() {
    if (!CV.mounted) return;
    const L = sessions();
    if (!L.length) { CV.dom.mapDots.innerHTML = ''; return; }
    const { tx, ty, z } = CV.view, vp = vpSize();
    const G = L.map((s) => geoOf(s.id));
    const wx0 = -tx / z, wy0 = -ty / z, wx1 = (vp.w - tx) / z, wy1 = (vp.h - ty) / z;
    const bx = Math.min(...G.map((g) => g.x), wx0) - 40, by = Math.min(...G.map((g) => g.y), wy0) - 40;
    const bx1 = Math.max(...G.map((g) => g.x + g.w), wx1) + 40, by1 = Math.max(...G.map((g) => g.y + g.h), wy1) + 40;
    const bw = Math.max(1, bx1 - bx), bh = Math.max(1, by1 - by), IW = 176, IH = 100;
    const k = Math.min(IW / bw, IH / bh), ox = 9 + (IW - bw * k) / 2, oy = 20 + (IH - bh * k) / 2;
    CV._map = { k, ox, oy, bx, by };
    CV.dom.mapDots.innerHTML = L.map((s) => {
      const g = geoOf(s.id), a = isAttn(s);
      return `<i class="${a ? 'a' : ''}" style="left:${ox + (g.x - bx) * k}px;top:${oy + (g.y - by) * k}px;
        width:${Math.max(a ? 4 : 3, g.w * k)}px;height:${Math.max(a ? 4 : 3, g.h * k)}px;
        background:${stColor(s)};opacity:${isDim(s) ? 0.35 : a ? 1 : 0.65}"></i>`;
    }).join('');
    Object.assign(CV.dom.mapVp.style, {
      left: ox + (wx0 - bx) * k + 'px', top: oy + (wy0 - by) * k + 'px',
      width: Math.max(6, (wx1 - wx0) * k) + 'px', height: Math.max(6, (wy1 - wy0) * k) + 'px',
    });
  }
  function onMapDown(e) {
    const m = CV._map; if (!m) return;
    const r = CV.dom.map.getBoundingClientRect();
    const wx = (e.clientX - r.left - m.ox) / m.k + m.bx, wy = (e.clientY - r.top - m.oy) / m.k + m.by;
    const vp = vpSize(), z = CV.view.z;
    tween({ z, tx: vp.w / 2 - wx * z, ty: vp.h / 2 - wy * z }, 240);
  }

  /* ---------- 手势 ---------- */
  function setMode(txt, hot) {
    CV.dom.mode.textContent = txt;
    CV.dom.mode.classList.toggle('hot', !!hot);
  }
  function onWheel(e) {
    if (CV.expanded || !CV.coachDone) return;
    e.preventDefault();
    // 选中的 tile 上滚轮 = 回看它的 tail(仅在 tail 行数多于可见行数时有意义)
    const tw = e.target.closest && e.target.closest('.cv-tile');
    if (tw && CV.sel.includes(tw.dataset.id)) {
      const s = state.sessions.get(tw.dataset.id);
      if (s) {
        const total = ((s.screenHtml != null ? s.screenHtml : s.tailHtml) || '').split('\n').length;
        const max = Math.max(0, total - tailRows(geoOf(s.id)));
        const next = clamp((CV.scroll[s.id] || 0) + (e.deltaY > 0 ? -1 : 1), 0, max);
        if (next !== (CV.scroll[s.id] || 0)) { CV.scroll[s.id] = next; paintTile(s); }
        return;
      }
    }
    const V = CV.view;
    if (e.ctrlKey || e.metaKey) {
      const r = CV.dom.vp.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      const z2 = clamp(V.z * Math.exp(-e.deltaY * 0.0016), Z_MIN, Z_MAX);
      setView({ z: z2, tx: cx - (cx - V.tx) * (z2 / V.z), ty: cy - (cy - V.ty) * (z2 / V.z) });
    } else {
      let dx = e.deltaX, dy = e.deltaY;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      setView({ z: V.z, tx: V.tx - dx, ty: V.ty - dy }, false);
    }
  }

  function startPan(e) {
    e.preventDefault();
    const V = { ...CV.view }, sx = e.clientX, sy = e.clientY;
    CV.panning = true; setMode('● 平移中', true);
    const mv = (ev) => { CV.view = { z: V.z, tx: V.tx + (ev.clientX - sx), ty: V.ty + (ev.clientY - sy) }; applyView(false); };
    const up = () => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      CV.panning = false; setMode(CV.space ? '○ 松开空格退出平移' : '画布', CV.space); save();
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  }

  function onVpDown(e) {
    if (CV.expanded || !CV.coachDone) return;
    if (e.target.closest('.cv-map') || e.target.closest('.cv-edge') || e.target.closest('.cv-hud')) return;
    if (e.button === 1 || CV.space) return startPan(e);
    if (e.button !== 0) return;
    if (e.target.closest('.cv-tile')) return; // tile 自己处理
    const r = CV.dom.vp.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    select([]);
    setMode('▢ 框选中', true);
    const mq = CV.dom.mq; mq.hidden = false;
    const draw = (x, y, w, h) => Object.assign(mq.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    draw(sx, sy, 0, 0);
    let box = { x: sx, y: sy, w: 0, h: 0 };
    const mv = (ev) => {
      const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
      box = { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) };
      draw(box.x, box.y, box.w, box.h);
    };
    const up = () => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      mq.hidden = true; setMode('画布');
      if (box.w <= 4 && box.h <= 4) return;
      const V = CV.view;
      const wx = (box.x - V.tx) / V.z, wy = (box.y - V.ty) / V.z, ww = box.w / V.z, wh = box.h / V.z;
      select(sessions().filter((s) => {
        const g = geoOf(s.id);
        return g.x < wx + ww && g.x + g.w > wx && g.y < wy + wh && g.y + g.h > wy;
      }).map((s) => s.id));
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  }

  function select(ids) {
    const next = new Set(ids);
    for (const [id, p] of CV.els) p.root.classList.toggle('sel', next.has(id));
    CV.sel = [...next];
  }

  function onTileDown(id, e) {
    if (CV.expanded || !CV.coachDone) return;
    if (e.button === 1 || CV.space) return startPan(e);
    if (e.button !== 0) return;
    if (e.target.closest('.cv-rz') || e.target.closest('.cv-exp')) return;
    e.stopPropagation();
    let sel = CV.sel.slice();
    if (!sel.includes(id)) sel = e.shiftKey ? sel.concat([id]) : [id];
    else if (e.shiftKey) sel = sel.filter((x) => x !== id);
    select(sel);

    const V = CV.view, sx = e.clientX, sy = e.clientY;
    const ids = CV.sel.includes(id) ? CV.sel : [id];
    const start = {};
    ids.forEach((k) => { const g = geoOf(k); start[k] = { x: g.x, y: g.y }; });
    let moved = false;
    const mv = (ev) => {
      const dx = (ev.clientX - sx) / V.z, dy = (ev.clientY - sy) / V.z;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      // 手动摆放和自动分区不可兼得:一动手就退出自动分区,免得下次状态变化把你摆的位置冲掉
      if (!moved && CV.laneMode) setLaneMode(false);
      moved = true; CV.dragging = true;
      for (const k of ids) {
        CV.geo[k].x = Math.round(start[k].x + dx);
        CV.geo[k].y = Math.round(start[k].y + dy);
        applyGeo(k);
      }
      paintMap();
    };
    const up = () => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      CV.dragging = false;
      if (moved) { save(); paintEdges(); }
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  }

  // 尺寸按字符网格吸附。松手时把 PTY 一起改掉,终端立刻按新尺寸重排 ——
  // 拖动过程中不改,否则每一帧都会让所有观察者的画面抖一次。
  function onResize(id, e, mode) {
    e.stopPropagation(); e.preventDefault();
    const V = CV.view, sx = e.clientX, sy = e.clientY;
    const g = geoOf(id), w0 = g.w, h0 = g.h;
    const mv = (ev) => {
      if (mode !== 's') g.w = Math.max(MIN_W, Math.round((w0 + (ev.clientX - sx) / V.z) / CH) * CH);
      if (mode !== 'e') g.h = Math.max(MIN_H, HDR + FTR + Math.round((h0 + (ev.clientY - sy) / V.z - HDR - FTR) / LH) * LH);
      applyGeo(id);
      const s = state.sessions.get(id);
      if (s) { paintTile(s); applyTier(s); }
    };
    const up = () => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      save(); paintMap();
      if (g.w === w0 && g.h === h0) return; // 没真正拖动
      const s = state.sessions.get(id);
      if (!s || !s.alive) return;
      const cols = colsOf(g), rows = rowsOf(g);
      if (s.ptyCols === cols && s.ptyRows === rows) return;
      const p = CV.els.get(id);
      if (p) p.root.classList.add('reflow'); // 等新画面回来之前给个"正在重排"的提示
      act(id, 'resize', { cols, rows })
        .catch((err) => toast('改尺寸失败', err.message, null, 5000))
        .finally(() => { if (p) setTimeout(() => p.root.classList.remove('reflow'), 600); });
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  }

  /* ---------- 键盘 ---------- */
  function onKeyDown(e) {
    if (!CV.mounted || state.view !== 'canvas') return;
    if (e.target.matches && e.target.matches('input,textarea')) return;
    if (e.key === ' ' && !CV.expanded) {
      if (!CV.space) { CV.space = true; CV.dom.vp.classList.add('grab'); setMode('○ 松开空格退出平移', true); }
      e.preventDefault(); return;
    }
    if (CV.expanded) { if (e.key === 'Escape') closeExpand(); return; }
    if (!CV.coachDone) { if (e.key === 'Enter' || e.key === 'Escape') showCoach(false, true); return; }
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n') nextAttention();
    else if (k === 'g') (CV.laneMode ? setLaneMode(false) : tidy());
    else if (e.key === '0') fitAll();
    else if (e.key === '1') zoomTo(1);
    else if (e.key === '?' || e.key === '/') showCoach(true);
    else if (e.key === 'Escape') select([]);
    else if (e.key === 'Enter' || k === 'f') { if (CV.sel[0]) openExpand(CV.sel[0]); }
  }
  function onKeyUp(e) {
    if (!CV.mounted) return;
    if (e.key === ' ' && CV.space) {
      CV.space = false; CV.dom.vp.classList.remove('grab');
      if (!CV.panning) setMode('画布');
    }
  }

  /* ---------- 命令 ---------- */
  function nextAttention() {
    const A = attnList(); if (!A.length) return;
    const cur = A.findIndex((s) => s.id === CV.sel[0]);
    const s = A[(cur + 1) % A.length];
    select([s.id]);
    centerOn(s.id, Math.max(CV.view.z, 0.8));
  }
  const LANES = [
    { k: '需要你 NEEDS YOU', c: 'var(--c-needs_decision)', s: ['needs_permission', 'needs_decision', 'blocked'] },
    { k: '待审 REVIEW', c: 'var(--c-review_ready)', s: ['review_ready'] },
    { k: '运行中 RUNNING', c: 'var(--c-executing)', s: ['executing', 'verifying'] },
    { k: '空闲 IDLE', c: 'var(--c-ready)', s: ['ready', 'terminal_only', 'stale'] },
    { k: '已结束 DONE', c: 'var(--c-completed)', s: ['completed', 'exited'] },
  ];
  // 按状态铺成泳道。只重排位置,保留每个 tile 自己的尺寸 —— 统一压成固定大小
  // 会把已经调好的「窗口 = PTY」关系毁掉,TUI 又会错位
  function layoutLanes() {
    const GX = 44, GY = 22, TOP = 54;
    CV.dom.world.querySelectorAll('.cv-lane').forEach((n) => n.remove());
    let lx = 0;
    const all = sessions();
    for (const lane of LANES) {
      // 组内按状态优先级再按名字排,避免每次重排顺序乱跳
      const mem = all.filter((s) => lane.s.includes(s.status)).sort((a, b) =>
        (lane.s.indexOf(a.status) - lane.s.indexOf(b.status)) || a.name.localeCompare(b.name));
      if (!mem.length) continue;
      const laneW = Math.max(...mem.map((s) => geoOf(s.id).w));
      let y = TOP;
      for (const s of mem) {
        const g = geoOf(s.id);
        const moved = g.x !== lx + 22 || g.y !== y;
        g.x = lx + 22; g.y = y;
        y += g.h + GY;
        const p = CV.els.get(s.id);
        // 只有自动归位时才给过渡:拖动必须瞬时跟手,不能有缓动尾巴
        if (p && moved) { p.root.classList.add('anim'); setTimeout(() => p.root.classList.remove('anim'), 520); }
        applyGeo(s.id); paintTile(s); applyTier(s);
      }
      const el = document.createElement('div');
      el.className = 'cv-lane';
      el.style.cssText = `transform:translate3d(${lx}px,0,0);width:${laneW + 44}px;height:${y - GY + 22}px;--cv-c:${lane.c}`;
      el.innerHTML = `<span>${esc(lane.k)}  ·  ${mem.length}</span>`;
      CV.dom.world.insertBefore(el, CV.dom.world.firstChild);
      lx += laneW + 44 + GX;
    }
    save();
    paintEdges(); paintMap();
  }

  function setLaneMode(on, quiet) {
    CV.laneMode = on;
    if (CV.dom && CV.dom.tidy) {
      CV.dom.tidy.classList.toggle('on', on);
      CV.dom.tidy.title = on
        ? '自动分区已开:状态一变就自动归位。拖动任意 tile 即退出'
        : '按状态自动分区(键 G):状态变化时 tile 会自动移到对应区域';
    }
    if (on) layoutLanes();
    else CV.dom.world.querySelectorAll('.cv-lane').forEach((n) => n.remove());
    save();
    if (!quiet) {
      toast(on ? '自动分区已开' : '自动分区已关',
        on ? '状态变化时 tile 会自动移到对应区域;拖动任意 tile 即退出' : '位置回归手动控制',
        null, 3500);
    }
  }
  function tidy() {
    if (CV.laneMode) { layoutLanes(); setTimeout(fitAll, 60); return; }
    setLaneMode(true);
    setTimeout(fitAll, 60);
  }

  // 状态变了就把 tile 挪到新分区。合并成一次重排:状态常常成批变化,
  // 逐个动会让画面连着抖好几次
  let relayoutTimer = null;
  function scheduleRelayout() {
    if (!CV.laneMode || relayoutTimer) return;
    relayoutTimer = setTimeout(() => { relayoutTimer = null; if (CV.laneMode) layoutLanes(); }, 260);
  }
  // 「清理」只是把画布上的已完成/已退出淡出并归档 —— 归档是真实动作,走后端
  function sweep() {
    const done = sessions().filter((s) => s.status === 'completed' || s.status === 'exited');
    if (!done.length) { toast('无可清理', '没有已完成或已退出的会话', null, 2500); return; }
    for (const s of done) {
      const p = CV.els.get(s.id);
      if (p) p.root.classList.add('fading');
    }
    setTimeout(() => {
      for (const s of done) act(s.id, 'archive').catch(() => { });
      toast('已清理', `${done.length} 个已结束会话已归档`, null, 3000);
    }, 430);
  }

  function showCoach(on, done) {
    const c = CV.dom.coach;
    if (on) { c.innerHTML = COACH; c.hidden = false; c.querySelector('#cv-coach-ok').onclick = () => showCoach(false, true); return; }
    if (!CV.coachDone && !done) { c.innerHTML = COACH; c.hidden = false; c.querySelector('#cv-coach-ok').onclick = () => showCoach(false, true); return; }
    c.hidden = true; c.innerHTML = '';
    if (done) { CV.coachDone = true; save(); }
  }

  /* ---------- 展开态:唯一的 live xterm ---------- */
  function openExpand(id) {
    const s = state.sessions.get(id); if (!s || CV.expanded) return;
    const p = CV.els.get(id); if (!p) return;
    // 上一次收起的清理还没跑完就又展开:必须撤掉,否则它会把新开的这层一起抹掉
    clearTimeout(CV.exTimer); CV.exTimer = null;
    CV.expanded = id;
    select([id]);
    p.root.classList.add('ghost');

    const g = geoOf(id), V = CV.view;
    const from = { l: g.x * V.z + V.tx, t: g.y * V.z + V.ty, w: g.w * V.z, h: g.h * V.z };
    const st = STATUS[s.status] || STATUS.ready;
    const host = CV.dom.expand;
    host.hidden = false;
    host.innerHTML = `
      <div class="cv-ex-panel" style="--cv-c:${stColor(s)};left:${from.l}px;top:${from.t}px;width:${from.w}px;height:${from.h}px">
        <div class="cv-ex-rail"></div>
        <div class="cv-ex-hd">
          <span class="cv-dot"></span>
          <span class="cv-ex-nm">${esc(s.name)}</span>
          <span class="cv-ex-dir">${esc(s.projectDir)}</span>
          <button class="cv-st" id="cv-ex-st" title="点击手工设定状态">${s.statusOverride ? '✎ ' : ''}${esc(st.label)}</button>
          <span class="cv-ex-sp"></span>
          <span class="cv-ex-pty" id="cv-ex-pty" title="展开态下 PTY 跟随窗口;要固定分辨率请在画布 tile 上改">PTY —</span>
          <button class="btn-ghost" id="cv-ex-take" hidden>接管控制</button>
          <button class="btn-ghost" id="cv-ex-close">收起 Esc</button>
        </div>
        <div class="cv-ex-term" id="cv-ex-term">
          <button class="cv-ex-bottom" id="cv-ex-bottom" hidden>↓ 回到底部</button>
        </div>
        <div class="cv-ex-ft">
          <span class="cv-ex-live">● live xterm(仅展开态存在)</span>
          <span id="cv-ex-hint">连接中…</span>
          <span class="cv-ex-sp"></span>
          <span id="cv-ex-scroll">滚轮 / Shift+PgUp 回看</span>
          <span>原位 x ${Math.round(g.x)} · y ${Math.round(g.y)}</span>
        </div>
      </div>`;
    const panel = host.querySelector('.cv-ex-panel');
    host.querySelector('#cv-ex-close').onclick = () => closeExpand();
    host.querySelector('#cv-ex-st').onclick = (e) => {
      e.stopPropagation();
      const cur = state.sessions.get(id);
      if (cur) openStatusMenu(e.currentTarget, cur);
    };
    host.addEventListener('mousedown', (e) => { if (e.target === host) closeExpand(); });
    // 终端里的滚轮必须留给 xterm 翻 scrollback,别冒泡到画布的平移/缩放
    host.addEventListener('wheel', (e) => e.stopPropagation());

    // 先落在 tile 原位,下一帧再展开 —— 让人看得见「从哪儿来」。
    // 终点用具体像素而不是 calc():px→calc 的插值在部分浏览器上不可靠,
    // 一旦插值失败面板就停在 tile 的小尺寸上,终端只剩几行高。
    const vp = vpSize();
    requestAnimationFrame(() => {
      host.classList.add('on');
      panel.classList.add('open');
      Object.assign(panel.style, {
        left: '26px', top: '26px', width: (vp.w - 52) + 'px', height: (vp.h - 52) + 'px',
      });
    });

    // xterm 必须在面板到达最终尺寸后才挂载:若在 tile 的小尺寸上 open()+fit(),
    // 服务端回放的 120 列内容会被硬折到 ~38 列,之后再 reflow 是有损的。
    CV.exMounted = false;
    const arrive = () => {
      if (CV.exMounted || CV.expanded !== id) return;
      CV.exMounted = true;
      clearTimeout(CV.exMountTimer); CV.exMountTimer = null;
      // 交回给 CSS 的 inset 布局,之后跟随窗口尺寸自适应
      panel.classList.add('full');
      panel.style.left = panel.style.top = panel.style.width = panel.style.height = '';
      mountTerm(s);
    };
    panel.addEventListener('transitionend', (ev) => { if (ev.propertyName === 'width') arrive(); });
    CV.exMountTimer = setTimeout(arrive, 420); // transitionend 不触发时的兜底
  }

  function mountTerm(s) {
    const hostEl = $('#cv-ex-term');
    if (!hostEl) return;
    CV.term = new Terminal({
      fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      theme: { background: '#15181d', foreground: '#d6dae2', cursor: '#e5a83b', selectionBackground: '#3a4150' },
      scrollback: 8000,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
    });
    CV.termFit = new FitAddon.FitAddon();
    CV.term.loadAddon(CV.termFit);
    CV.term.open(hostEl);
    CV.termFit.fit();

    const ptyEl = $('#cv-ex-pty'), hintEl = $('#cv-ex-hint'), takeEl = $('#cv-ex-take');
    const showDims = () => { if (ptyEl && CV.term) ptyEl.textContent = `PTY ${CV.term.cols}×${CV.term.rows}`; };
    showDims();

    CV.termWs = new WebSocket(`${WS_BASE}/ws/term/${s.id}`, wsProto());
    CV.termWs.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'data') CV.term.write(m.data);
      else if (m.type === 'role') {
        CV.termCtl = m.controller;
        if (takeEl) takeEl.hidden = m.controller;
        if (hintEl) hintEl.textContent = m.controller ? '键盘直连 PTY · Esc 收起' : '只读观察 —— 点「接管控制」后才能输入';
        if (m.controller && CV.termWs.readyState === 1) {
          CV.termWs.send(JSON.stringify({ type: 'resize', cols: CV.term.cols, rows: CV.term.rows }));
        }
      } else if (m.type === 'exit') {
        CV.term.write(`\r\n\x1b[90m[进程已退出,code ${m.code}]\x1b[0m\r\n`);
      }
    };
    CV.termWs.onclose = () => { if (hintEl && CV.expanded) hintEl.textContent = '连接已断开'; };
    if (takeEl) takeEl.onclick = () => CV.termWs.readyState === 1 && CV.termWs.send(JSON.stringify({ type: 'take-control' }));
    CV.term.onData((d) => { if (CV.termCtl && CV.termWs.readyState === 1) CV.termWs.send(JSON.stringify({ type: 'input', data: d })); });
    CV.term.onResize(({ cols, rows }) => {
      showDims();
      // 只有 controller 才真正改 PTY:尺寸全会话共享,观察者不该动它
      if (CV.termCtl && CV.termWs.readyState === 1) CV.termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    CV.termRO = new ResizeObserver(() => CV.termFit && CV.termFit.fit());
    CV.termRO.observe(hostEl);

    // 回看提示:离开底部就给一个回去的入口,否则很容易以为终端卡住了
    const btm = $('#cv-ex-bottom'), scrollEl = $('#cv-ex-scroll');
    const syncScroll = () => {
      if (!CV.term || !btm) return;
      const b = CV.term.buffer.active;
      const back = Math.max(0, b.baseY - b.viewportY);
      btm.hidden = back === 0;
      if (scrollEl) scrollEl.textContent = back ? `已上翻 ${back} 行` : '滚轮 / Shift+PgUp 回看';
    };
    CV.term.onScroll(syncScroll);
    if (btm) btm.onclick = () => { CV.term.scrollToBottom(); syncScroll(); };

    CV.term.focus();
  }

  function disposeTerm() {
    if (CV.termWs) { CV.termWs.onclose = null; CV.termWs.close(); CV.termWs = null; }
    if (CV.termRO) { CV.termRO.disconnect(); CV.termRO = null; }
    if (CV.term) { CV.term.dispose(); CV.term = null; }
    CV.termFit = null; CV.termCtl = false;
  }

  function closeExpand(immediate) {
    if (!CV.expanded) return;
    const id = CV.expanded;
    CV.expanded = null;
    disposeTerm();
    const p = CV.els.get(id);
    if (p) p.root.classList.remove('ghost');
    const host = CV.dom && CV.dom.expand;
    if (!host) return;
    const panel = host.querySelector('.cv-ex-panel');
    clearTimeout(CV.exTimer);
    clearTimeout(CV.exMountTimer); CV.exMountTimer = null;
    CV.exMounted = false;
    host.classList.remove('on');
    if (immediate || !panel) { CV.exTimer = null; host.hidden = true; host.innerHTML = ''; return; }
    // 现在的尺寸来自 CSS inset,要动画回 tile 就得先把它固化成像素起点
    const pr = panel.getBoundingClientRect(), hr = host.getBoundingClientRect();
    panel.classList.remove('full');
    Object.assign(panel.style, {
      left: (pr.left - hr.left) + 'px', top: (pr.top - hr.top) + 'px',
      width: pr.width + 'px', height: pr.height + 'px',
    });
    void panel.offsetWidth; // 强制回流,确保起点被采纳后再改终点,否则不会有过渡
    const g = geoOf(id), V = CV.view;
    Object.assign(panel.style, {
      left: g.x * V.z + V.tx + 'px', top: g.y * V.z + V.ty + 'px',
      width: g.w * V.z + 'px', height: g.h * V.z + 'px',
    });
    CV.exTimer = setTimeout(() => {
      CV.exTimer = null;
      panel.classList.remove('open');
      host.hidden = true; host.innerHTML = '';
    }, 370);
  }

  /* ---------- 对外 ---------- */
  window.CCCanvas = {
    render(host) { if (!CV.mounted) mount(host); else { syncTiles(); applyView(); } },
    dispose,
    isActive: () => CV.mounted,
    // SSE 推来新画面:只重画那一个 tile,不碰视图与其他 tile
    onTail(id) {
      if (!CV.mounted) return;
      const s = state.sessions.get(id);
      if (s && CV.els.has(id)) paintTail(s);
    },
    // 会话状态变化(增删/状态迁移)
    onSessions() { if (CV.mounted) syncTiles(); },
    focus(id) { if (CV.mounted) { select([id]); centerOn(id, Math.max(CV.view.z, 0.8)); } },
  };
})();
