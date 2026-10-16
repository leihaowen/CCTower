/* Persistent workspace tools. Clipboard text stays local until explicit Enter. */
'use strict';
window.CCWorkspaceTools = (() => {
  let desktopOrigin = null;
  const clipboardRequests = new Map();
  window.addEventListener('message', (event) => {
    if (window.parent === window || event.source !== window.parent) return;
    if (!['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:1420'].includes(event.origin)) return;
    if (event.data?.type === 'ccw:desktop-ready') desktopOrigin = event.origin;
    if (event.data?.type === 'ccw:clipboard-result') clipboardRequests.get(event.data.requestId)?.(event.data.text);
    if (event.data?.type === 'ccw:download-result') toast(event.data.success ? '下载完成' : '下载失败', event.data.path || '请重试');
  });
  function clipboardText() {
    if (desktopOrigin) return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { clipboardRequests.delete(requestId); resolve(null); }, 3000);
      clipboardRequests.set(requestId, (text) => { clearTimeout(timer); clipboardRequests.delete(requestId); resolve(text); });
      window.parent.postMessage({ type: 'ccw:clipboard-read', requestId }, desktopOrigin);
    });
    return navigator.clipboard?.readText().catch(() => null) || Promise.resolve(null);
  }
  let selectedId = null;
  const explorers = new Map();
  const terminals = new Map();
  let current = null, generation = 0;
  const drawer = document.createElement('section');
  drawer.id = 'quick-terminal'; drawer.hidden = true;
  drawer.innerHTML = `<header><b>快捷终端</b><span id="quick-directory"></span><span id="quick-status"></span><button id="quick-control" class="btn-ghost">接管</button><button id="quick-hide" class="btn-ghost">收起 ⌃\u0060</button></header><div id="quick-hosts"></div><form id="quick-form"><textarea id="quick-command" rows="2" aria-label="待执行命令" placeholder="粘贴命令，Enter 发送，Shift+Enter 换行"></textarea><button class="btn-primary" type="submit">发送 ↵</button></form>`;
  document.body.append(drawer);
  const command = drawer.querySelector('textarea');
  const status = drawer.querySelector('#quick-status');
  function select(id) { if (id) selectedId = id; }
  function hide() {
    generation++;
    if (current) current.draft = command.value;
    drawer.hidden = true; document.body.classList.remove('quick-open');
  }
  drawer.querySelector('#quick-hide').onclick = hide;
  function send(t, msg) { if (t.ws?.readyState === 1) { t.ws.send(JSON.stringify(msg)); return true; } return false; }
  function reflect(t) {
    if (current !== t) return;
    status.textContent = t.exited ? '已退出 · 再次打开可重启' : t.controller ? '已连接' : '连接中 / 只读';
    drawer.querySelector('#quick-control').hidden = t.controller;
    drawer.querySelector('button[type=submit]').disabled = !t.controller || t.exited;
  }
  function connect(t, replay = false) {
    if (replay) t.term.reset();
    let autoTake = true;
    const ws = t.ws = new WebSocket(`${WS_BASE}/ws/term/${t.id}`, wsProto());
    ws.onmessage = (event) => {
      const m = JSON.parse(event.data);
      if (m.type === 'data') t.term.write(m.data);
      if (m.type === 'role') {
        t.controller = m.controller;
        if (!m.controller && autoTake) send(t, { type: 'take-control' });
        autoTake = false;
        if (t.controller) send(t, { type: 'resize', cols: t.term.cols, rows: t.term.rows });
        reflect(t);
      }
      if (m.type === 'exit') { t.exited = true; t.controller = false; t.term.write('\r\n[终端已退出]\r\n'); reflect(t); }
    };
    ws.onclose = () => {
      t.controller = false; reflect(t);
      if (!t.exited) t.retry = setTimeout(() => connect(t, true), 2000);
    };
  }
  async function open(text) {
    const source = state.sessions.get(selectedId || state.currentId);
    if (!source) { toast('请先选择会话', '终端将从该会话的工作目录启动'); return; }
    const seq = ++generation;
    // Initiate clipboard read during the click/key gesture, before any network await.
    const clip = text !== undefined ? Promise.resolve(text) : clipboardText();
    if (current) current.draft = command.value;
    current = null;
    for (const item of terminals.values()) item.host.hidden = true;
    drawer.querySelector('button[type=submit]').disabled = true;
    drawer.hidden = false; document.body.classList.add('quick-open');
    command.value = ''; command.disabled = true; status.textContent = '连接中…';
    try {
      const info = await api(`/api/sessions/${source.id}/quick-terminal`, {});
      if (seq !== generation) return;
      let t = terminals.get(info.id);
      if (!t) {
        const host = document.createElement('div'); host.className = 'quick-host'; drawer.querySelector('#quick-hosts').append(host);
        const term = new Terminal({ fontSize: 13, scrollback: 5000, theme: { background: '#0e1013', foreground: '#d6dae2' }, macOptionClickForcesSelection: true });
        const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
        t = { id: info.id, host, term, fit, draft: '', controller: false, exited: false };
        terminals.set(info.id, t);
        term.onData((data) => { if (t.controller) send(t, { type: 'input', data }); });
        term.onResize(({ cols, rows }) => { if (t.controller) send(t, { type: 'resize', cols, rows }); });
        new ResizeObserver(() => { if (!drawer.hidden && current === t) fit.fit(); }).observe(host);
        connect(t);
      } else if (t.exited || !t.controller) {
        clearTimeout(t.retry); t.ws.onclose = null; t.ws.close(); t.exited = false; connect(t, true);
      }
      current = t;
      for (const item of terminals.values()) item.host.hidden = item !== t;
      drawer.querySelector('#quick-directory').textContent = `${source.name} · ${info.cwd}（保留 shell 当前目录）`;
      command.value = t.draft; command.disabled = false; command.focus(); t.fit.fit(); reflect(t);
      const before = command.value, clipboard = await clip;
      if (seq !== generation || current !== t) return;
      if (text !== undefined || (!before && command.value === before)) {
        if (clipboard !== null) command.value = clipboard;
      }
      if (clipboard === null) command.placeholder = '剪贴板未授权，请按 Cmd+V / Ctrl+V 粘贴，Enter 发送';
    } catch (e) { if (seq === generation) { status.textContent = e.message; command.disabled = true; } }
  }
  drawer.querySelector('#quick-control').onclick = () => current && send(current, { type: 'take-control' });
  drawer.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    if (!current?.controller || current.exited || !command.value.trim()) return;
    // Control sequences are not commands; the staged editor never forwards raw escapes.
    const text = command.value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (send(current, { type: 'input', data: text + '\r' })) { current.draft = ''; command.value = ''; current.term.focus(); }
  };
  command.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); drawer.querySelector('form').requestSubmit(); } };
  command.oninput = () => { if (current) current.draft = command.value; };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'Backquote') { e.preventDefault(); e.stopImmediatePropagation(); drawer.hidden ? open() : hide(); }
    else if (e.key === 'Escape' && !drawer.hidden) { e.preventDefault(); e.stopImmediatePropagation(); hide(); }
  }, true);
  document.querySelector('#quick-toggle').onclick = () => drawer.hidden ? open() : hide();

  function mountExplorer(parent, session) {
    select(session.id);
    let model = explorers.get(session.id);
    if (!model) {
      const el = document.createElement('section'); el.className = 'file-explorer';
      el.innerHTML = `<header><b>资源管理器</b><button class="btn-ghost files-refresh" title="刷新文件列表">⟳</button><button class="btn-ghost files-upload">上传</button><input type="file" multiple hidden></header><div class="files-nav"><button class="btn-ghost files-up">↑</button><span class="files-path"></span></div><div class="files-message" role="status"></div><div class="files-list"></div><div class="files-drop">拖入文件上传到当前目录</div><div class="files-download-drop">将列表文件拖到这里，下载到本机</div>`;
      model = { el, path: '.', seq: 0, busy: false, urls: new Map() }; explorers.set(session.id, model);
      const message = (text) => { el.querySelector('.files-message').textContent = text; };
      const join = (name) => model.path === '.' ? name : `${model.path}/${name}`;
      async function ticket(file) {
        const r = await api(`/api/sessions/${session.id}/files/ticket`, { path: file });
        const url = new URL(r.url, location.href).href; model.urls.set(file, { url, at: Date.now() }); return url;
      }
      async function download(file) {
        try { const a = document.createElement('a'); a.href = await ticket(file); a.download = file.split('/').pop(); document.body.append(a); a.click(); a.remove(); message('下载已开始'); }
        catch (e) { message(e.message); }
      }
      async function refresh(dir = model.path) {
        const seq = ++model.seq;
        try {
          const r = await api(`/api/sessions/${session.id}/files?path=${encodeURIComponent(dir)}`);
          if (seq !== model.seq) return;
          model.path = r.path; model.parent = r.parent;
          el.querySelector('.files-path').textContent = r.path === '.' ? r.root : r.path;
          el.querySelector('.files-path').title = r.root + '/' + r.path;
          el.querySelector('.files-up').disabled = !r.parent;
          const list = el.querySelector('.files-list'); list.replaceChildren();
          for (const file of r.files) {
            const row = document.createElement('div'); row.className = 'file-row';
            const name = document.createElement('button'); name.className = 'file-name'; name.textContent = `${file.directory ? '▸' : '·'} ${file.name}`; name.title = file.name;
            row.append(name); list.append(row);
            const filePath = join(file.name);
            if (file.directory) name.onclick = () => refresh(filePath);
            else {
              name.onclick = () => download(filePath);
              const btn = document.createElement('button'); btn.className = 'file-download'; btn.textContent = '↓'; btn.title = `下载 ${file.name} (${file.size} 字节)`; btn.onclick = () => download(filePath); row.append(btn);
              row.draggable = true;
              row.onpointerdown = () => { ticket(filePath).catch(() => {}); };
              row.ondragstart = (e) => {
                e.dataTransfer.setData('application/x-ccw-file', JSON.stringify({ id: session.id, path: filePath }));
                const cached = model.urls.get(filePath);
                if (cached && Date.now() - cached.at < 100000) e.dataTransfer.setData('DownloadURL', `application/octet-stream:${file.name}:${cached.url}`);
                e.dataTransfer.effectAllowed = 'copy';
              };
            }
          }
          if (!r.files.length) list.textContent = '目录为空';
        } catch (e) { if (seq === model.seq) message(e.message); }
      }
      async function upload(files) {
        if (model.busy) return;
        model.busy = true;
        const dir = model.path;
        let success = 0; const failures = [];
        for (const file of files) {
          message(`上传 ${file.name}…`);
          try {
            if (file.size > 256 * 1024 * 1024) throw new Error('超过 256 MB');
            const r = await fetch(`/api/sessions/${session.id}/files?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: file });
            if (!r.ok) throw new Error((await r.json()).error);
            success++;
          } catch (e) { failures.push(`${file.name}: ${e.message}`); }
        }
        model.busy = false; await refresh(); message(`已上传 ${success} 个文件${failures.length ? '；' + failures.join('；') : ''}`);
      }
      el.querySelector('.files-refresh').onclick = () => refresh();
      el.querySelector('.files-up').onclick = () => model.parent && refresh(model.parent);
      el.querySelector('.files-upload').onclick = () => el.querySelector('input').click();
      el.querySelector('input').onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
      el.ondragover = (e) => { e.preventDefault(); el.classList.add('drag-over'); };
      el.ondragleave = (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over'); };
      el.ondrop = (e) => {
        e.preventDefault(); el.classList.remove('drag-over');
        const internal = e.dataTransfer.getData('application/x-ccw-file');
        if (internal) { try { const item = JSON.parse(internal); if (item.id === session.id && e.target.closest('.files-download-drop')) download(item.path); } catch {} return; }
        const items = [...e.dataTransfer.items];
        if (items.some((i) => i.webkitGetAsEntry?.()?.isDirectory)) { message('请拖入文件；目录请先压缩后上传'); return; }
        upload([...e.dataTransfer.files]);
      };
      model.refresh = refresh; refresh();
    }
    parent.querySelector('.col-head').after(model.el);
  }
  return { select, open, mountExplorer };
})();
