(function() {
  'use strict';
  const OLLAMA_HOST = localStorage.getItem('gooey_ollama_host') || 'http://127.0.0.1:11434';
  const IMAGE_TYPES = ['image/png','image/jpeg','image/gif','image/webp'];

  let projects = JSON.parse(localStorage.getItem('gooey_projects') || '{}');
  let conversations = JSON.parse(localStorage.getItem('gooey_conversations') || '{}');
  let activeProjectId = null;
  let activeChatId = null;
  let chatAttachments = [];
  let saveTimeout = null;
  let storageRevision = 0;
  let abortControllers = {};
  let streamingChats = {};
  let resumeTokens = {};
  function bumpResumeToken(cid) { resumeTokens[cid] = (resumeTokens[cid] || 0) + 1; return resumeTokens[cid]; }
  function resumeToken(cid) { return resumeTokens[cid] || 0; }
  function isChatStreaming(cid) { return !!(cid && streamingChats[cid]); }
  function endStreamState(cid, showInDom) {
    delete streamingChats[cid];
    delete abortControllers[cid];
    if (showInDom && typeof setStreamingUI === 'function') setStreamingUI(false);
  }

  // --- Marked setup ---
  marked.setOptions({ breaks: true });
  const renderer = new marked.Renderer();
  renderer.code = function(codeOrToken, infostring) {
    let t, lang;
    if (codeOrToken && typeof codeOrToken === 'object') {
      // marked >= v5+ token-object API
      t = codeOrToken.text != null ? codeOrToken.text : (codeOrToken.code || '');
      lang = codeOrToken.lang != null ? codeOrToken.lang : '';
    } else {
      t = codeOrToken || '';
      lang = infostring || '';
    }
    t = String(t || '');
    lang = String(lang || '').trim();
    const langLabel = lang || 'text';
    // Bounded highlighting: huge or unclosed-fence code blocks (mid-stream) would hang the tab
    let highlighted;
    if (t.length > 4000) {
      highlighted = esc(t);
    } else if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(t, { language: lang }).value;
    } else if (t.length < 1000) {
      highlighted = hljs.highlightAuto(t).value;
    } else {
      highlighted = esc(t);
    }
    const lineCount = (t.match(/\n/g) || []).length;
    const collapse = lineCount > 30 ? ' collapsed' : '';
    const toggleBtn = lineCount > 30 ? `<button class="code-toggle" data-action="toggle-code">Show ${lineCount} lines</button>` : '';
    return `<div class="code-block${collapse}"><div class="code-block-header"><span>${esc(langLabel)}</span><div>${toggleBtn}<button class="copy-code-btn" data-action="copy-code">Copy</button></div></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
  };
  marked.use({ renderer });

  function renderMd(src) {
    try {
      if (src.length > 30000) return DOMPurify.sanitize('<p>' + esc(src.slice(0, 30000)) + '</p>');
      return DOMPurify.sanitize(marked.parse(src));
    }
    catch { return DOMPurify.sanitize(esc(src)); }
  }

  function stripFileOps(content) {
    return cleanToolLeftovers(content);
  }

  // --- Tool-tag cleanup helpers ---
  const FILE_OP_NAMES = ['create_file', 'edit_file', 'append_file', 'delete_file', 'read_file', 'create_dir'];

  function removeFileOpTags(content) {
    let c = content;
    FILE_OP_NAMES.forEach(name => {
      const openRe = new RegExp('<' + name + '\\s+path=\\s*["\'][^"\']*["\'][^>]*>', 'gi');
      const closeRe = new RegExp('</\\s*' + name + '\\s*>', 'gi');
      const openers = [];
      let om;
      while ((om = openRe.exec(c)) !== null) openers.push(om.index);
      if (!openers.length) return;
      closeRe.lastIndex = 0;
      const closers = [];
      let cm;
      while ((cm = closeRe.exec(c)) !== null) closers.push({ index: cm.index, len: cm[0].length });
      const spans = [];
      for (let k = 0; k < openers.length; k++) {
        const start = openers[k];
        const upper = k + 1 < openers.length ? openers[k + 1] : c.length + 1;
        let end = -1, endLen = 0;
        for (const cl of closers) { if (cl.index >= start && cl.index < upper) { end = cl.index; endLen = cl.len; } }
        spans.push({ start, end: (end === -1 ? c.length : end + endLen) });
      }
      spans.sort((a, b) => b.start - a.start);
      for (const s of spans) c = c.slice(0, s.start) + c.slice(s.end);
    });
    return c;
  }

  function stripSearchPairs(content) {
    return content.replace(/<search>[\s\S]*?<\/search>/gi, '');
  }

  function stripToolTagDebris(content) {
    return content
      .replace(/<\/(?:create_file|edit_file|append_file|delete_file|read_file|create_dir|search_info|read_info|search_chats|search)\s*>/gi, '')
      .replace(/<\/\s*(?:create|edit|append|delete|read)\s+file\s*>/gi, '')
      .replace(/<\/\s*create\s+dir\s*>/gi, '');
  }

  function collapseOrphanFences(content) {
    return content
      .replace(/```[a-zA-Z0-9]{0,12}\r?\n\s*```/gi, '')
      .replace(/\n?```[a-zA-Z0-9]{0,12}\s*$/gi, '')
      .replace(/^```[a-zA-Z0-9]{0,12}\s*/i, '')
      .trim();
  }

  function cleanToolLeftovers(content) {
    let c = stripToolTagDebris(stripSearchPairs(removeFileOpTags(content)));
    c = c.replace(/<(?:\/)?(?:search_info|read_info|search_chats|search)>/gi, '').trim();
    return collapseOrphanFences(c);
  }

  function findTagSpans(content) {
    const pairs = [];
    FILE_OP_NAMES.forEach(name => {
      const openRe = new RegExp('<' + name + '\\s+path=\\s*["\'][^"\']*["\'][^>]*>', 'gi');
      const closeRe = new RegExp('</\\s*' + name + '\\s*>', 'gi');
      const openers = [];
      let om;
      while ((om = openRe.exec(content)) !== null) openers.push({ index: om.index, oe: om.index + om[0].length, path: (om[0].match(/path=\s*["']([^"']*)["']/i) || [])[1] || '' });
      if (!openers.length) return;
      closeRe.lastIndex = 0;
      const closers = [];
      let cm;
      while ((cm = closeRe.exec(content)) !== null) closers.push({ index: cm.index, len: cm[0].length });
      for (let k = 0; k < openers.length; k++) {
        const o = openers[k];
        const upper = k + 1 < openers.length ? openers[k + 1].index : content.length + 1;
        let end = -1, endLen = 0;
        for (const cl of closers) { if (cl.index >= o.oe && cl.index < upper) { end = cl.index; endLen = cl.len; } }
        if (end !== -1) pairs.push({ type: name, path: o.path, start: o.index, oe: o.oe, bodyStart: o.oe, bodyEnd: end, endAfter: end + endLen });
      }
    });
    return pairs.sort((a, b) => a.start - b.start);
  }

  function extractFileOps(content) {
    const ops = [];
    findTagSpans(content).forEach(t => {
      const body = content.slice(t.bodyStart, t.bodyEnd).trim();
      const op = { type: t.type, path: t.path };
      if (t.type === 'edit_file') {
        const oldRe = /<old>([\s\S]*?)<\/old>/i.exec(body);
        const newRe = /<new>([\s\S]*?)<\/new>/i.exec(body);
        if (oldRe && newRe) {
          op.old = oldRe[1];
          op.new = newRe[1];
          op.content = 'OLD:\n' + oldRe[1] + '\n\nNEW:\n' + newRe[1];
        } else if (newRe) {
          op.new = newRe[1];
          op.content = 'Full rewrite';
        } else if (oldRe) {
          op.old = oldRe[1];
          op.content = null;
          op.invalid = 'edit_file needs both <old> and <new>';
        } else if (!body) {
          op.invalid = 'edit_file is empty';
        } else {
          op.content = body;
        }
      } else {
        op.content = body;
      }
      ops.push(op);
    });
    return ops;
  }

  function msgLen(m) {
    return (m.content || '').length + ((m.images && m.images.length) ? m.images.length * 5620 : 0);
  }
  function chatIdNum(id) {
    const m = String(id || '').match(/^\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }
  function searchSources(m) {
    if (!m.searchCards) return '';
    const urls = [];
    (m.searchCards || []).forEach(c => (c.results || []).forEach(r => { if (r.url && urls.indexOf(r.url) === -1) urls.push(r.url); }));
    return urls.length ? '\n\nSources: ' + urls.join(', ') : '';
  }
  function abortIfStreaming() {
    const cids = Object.keys(streamingChats);
    cids.forEach(cid => {
      bumpResumeToken(cid);
      const ac = abortControllers[cid];
      if (ac) ac.abort();
    });
    cids.forEach(cid => endStreamState(cid, cid === activeChatId));
    try { const loader = document.getElementById('gooey-loading'); if (loader) loader.remove(); } catch {}
  }
  function performFileOp(op, chatId) {
    const cid = chatId || activeChatId;
    if (op.type === 'create_file' || op.type === 'edit_file') {
      if (op.invalid) return op.invalid;
      if (/\.(xlsx|xls|ods)$/i.test(op.path)) {
        return 'A real .xlsx is a binary ZIP and cannot be typed by hand; create a .csv instead.';
      }
      if (op.type === 'edit_file' && op.old !== undefined && op.new === undefined) {
        return 'edit_file needs both <old> and <new>';
      }
      if (op.type === 'edit_file' && op.old === undefined) {
        return (async () => {
          const checkRes = await fetch('/api/files/' + encodeURIComponent(op.path) + '?chatId=' + encodeURIComponent(cid));
          if (checkRes.ok) {
            return `edit_file without <old> cannot overwrite existing file '${op.path}'; use create_file or provide <old>`;
          }
          const body = { chatId: cid, path: op.path };
          body.content = (op.content === 'Full rewrite') ? (op.new || '') : (op.new || op.content || '');
          const res = await fetch('/api/files', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const data = await res.json();
          if (data.error) return data.error;
          refreshFileTree();
          return null;
        })();
      }
      const body = { chatId: cid, path: op.path };
      if (op.old !== undefined) { body.old = op.old; body.new = op.new; } else { body.content = op.content || ''; }
      return (async () => {
        const res = await fetch('/api/files', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (data.error) return data.error;
        refreshFileTree();
        return null;
      })();
    } else if (op.type === 'create_dir') {
      return (async () => {
        const res = await fetch('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: cid, mkdir: op.path }) });
        const data = await res.json().catch(() => ({}));
        if (data.error) return data.error;
        refreshFileTree();
        return null;
      })();
    } else if (op.type === 'append_file') {
      return (async () => {
        const res = await fetch('/api/files', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: cid, path: op.path, append: true, content: op.content || '' }) });
        const data = await res.json().catch(() => ({}));
        if (data.error) return data.error;
        refreshFileTree();
        return null;
      })();
    } else if (op.type === 'delete_file') {
      return (async () => {
        const res = await fetch('/api/files/' + encodeURIComponent(op.path) + '?chatId=' + encodeURIComponent(cid), { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (data.error) return data.error;
        refreshFileTree();
        return null;
      })();
    } else if (op.type === 'read_file') {
      return (async () => {
        const res = await fetch('/api/files/' + encodeURIComponent(op.path) + '?chatId=' + encodeURIComponent(cid));
        if (res.status === 404) return { notFound: true };
        const data = await res.json();
        if (data.error) return { value: data.error };
        return { content: data.content, size: data.size || 0 };
      })();
    }
    return null;
  }

  // --- Persistence (file-backed) ---
  let saveChain = Promise.resolve();
  function fetchPost(data) {
    return fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data }).then(async function(res) {
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    });
  }
  function sanitizeContentForStorage(content) {
    const c = String(content || '');
    if (!/<(?:\/)?(?:create_file|edit_file|append_file|delete_file|read_file|create_dir|search_info|read_info|search_chats|search)\b/i.test(c)) return c;
    return cleanToolLeftovers(c);
  }
  function snapshotForPersistence() {
    const convSnap = {};
    for (const cid of Object.keys(conversations)) {
      const conv = conversations[cid];
      const messages = (conv.messages || []).map(m => {
        const copy = Object.assign({}, m);
        if (copy.content) copy.content = sanitizeContentForStorage(copy.content);
        if (copy.lastTool && copy.lastTool.content) copy.lastTool.content = sanitizeContentForStorage(copy.lastTool.content);
        delete copy.images;
        return copy;
      });
      convSnap[cid] = Object.assign({}, conv, { messages });
    }
    return { projects, conversations: convSnap };
  }
  function localFallback(snap) {
    try {
      localStorage.setItem('gooey_projects', JSON.stringify(snap.projects || {}));
      localStorage.setItem('gooey_conversations', JSON.stringify(snap.conversations || {}));
      localStorage.setItem('gooey_revision', String(storageRevision));
    } catch {}
  }
  function save() {
    storageRevision += 1;
    const snap = snapshotForPersistence();
    saveChain = saveChain.then(async () => {
      const data = JSON.stringify({ revision: storageRevision, projects: snap.projects, conversations: snap.conversations });
      const r = await fetchPost(data);
      if (r.ok) {
        if (typeof r.body.revision === 'number') storageRevision = r.body.revision;
        return;
      }
      if (r.status === 409) {
        // Conflict: rebased against server's revision and retry once
        try {
          const res = await fetch('/api/storage');
          const srv = await res.json();
          if (srv && typeof srv.revision === 'number') storageRevision = srv.revision;
        } catch {}
        storageRevision += 1;
        const retrySnap = snapshotForPersistence();
        const retryData = JSON.stringify({ revision: storageRevision, projects: retrySnap.projects, conversations: retrySnap.conversations });
        const r2 = await fetchPost(retryData);
        if (r2.ok) {
          if (typeof r2.body.revision === 'number') storageRevision = r2.body.revision;
          return;
        }
      }
      throw new Error('HTTP ' + r.status);
    }).catch(() => localFallback(snap));
    return saveChain;
  }

  // Flush on page close/reload so in-flight state (incl. streamed replies) survives tab kills
  function flushToLocal() {
    try {
      const snap = snapshotForPersistence();
      localStorage.setItem('gooey_projects', JSON.stringify(snap.projects));
      localStorage.setItem('gooey_conversations', JSON.stringify(snap.conversations));
      localStorage.setItem('gooey_revision', String(storageRevision));
    } catch (e) {
      try { console.error('Failed to flush to localStorage', e); } catch {}
    }
  }
  window.addEventListener('pagehide', flushToLocal);
  window.addEventListener('beforeunload', flushToLocal);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) flushToLocal();
  });
  document.addEventListener('freeze', flushToLocal);
  async function loadStorage() {
    let localRevision = null;
    try {
      const lr = localStorage.getItem('gooey_revision');
      if (lr !== null) localRevision = parseInt(lr, 10);
      if (localRevision !== null && isNaN(localRevision)) localRevision = null;
    } catch {}
    let localSnap = null;
    try {
      const p = localStorage.getItem('gooey_projects');
      const c = localStorage.getItem('gooey_conversations');
      if (p || c) localSnap = { projects: p ? JSON.parse(p) : {}, conversations: c ? JSON.parse(c) : {} };
    } catch {}
    let useServer = false;
    try {
      const res = await fetch('/api/storage');
      const data = await res.json();
      const serverRev = typeof data.revision === 'number' ? data.revision : 0;
      if (localRevision === null || serverRev >= localRevision) {
        useServer = true;
        if (data.projects) projects = data.projects;
        if (data.conversations) conversations = data.conversations;
        storageRevision = Math.max(serverRev, localRevision !== null ? localRevision : 0);
        // Merge in projects/chats that exist ONLY locally — created (or changed) while
        // the server was down — instead of silently dropping them when the server returns (#70)
        if (localSnap) {
          Object.keys(localSnap.projects || {}).forEach(pid => {
            if (!projects[pid] && localSnap.projects[pid]) projects[pid] = localSnap.projects[pid];
          });
          Object.keys(localSnap.conversations || {}).forEach(cid => {
            if (!conversations[cid] && localSnap.conversations[cid]) conversations[cid] = localSnap.conversations[cid];
          });
        }
      }
    } catch {}
    if (!useServer) {
      // Fallback to localStorage
      try {
        if (localSnap) {
          if (localSnap.projects) projects = localSnap.projects;
          if (localSnap.conversations) conversations = localSnap.conversations;
        }
        storageRevision = localRevision !== null ? localRevision : 0;
      } catch {}
    }
  }
  async function clearEverything() {
    showDialog({
      title: 'Clear everything',
      message: 'Delete ALL projects, chats, and settings? This cannot be undone.',
      confirmLabel: 'Delete everything',
      danger: true,
      onConfirm: doClearEverything
    });
  }
  async function doClearEverything() {
    abortIfStreaming();
    clearTimeout(saveTimeout);
    projects = {};
    conversations = {};
    activeProjectId = null;
    activeChatId = null;
    viewingProjectId = null;
    chatAttachments = [];
    try {
      const del = await fetch('/api/storage', { method: 'DELETE' });
      if (!del.ok) throw new Error('HTTP ' + del.status);
    } catch (e) {
      showDialog({ title: 'Clear failed', message: e.message || 'Failed to clear server storage' });
      return;
    }
    storageRevision += 1;
    try {
      const snap = snapshotForPersistence();
      const data = JSON.stringify({ revision: storageRevision, projects: snap.projects, conversations: snap.conversations });
      saveChain = saveChain.then(async () => {
        const r = await fetchPost(data);
        if (r.status === 409) {
          try {
            const srv = await (await fetch('/api/storage')).json();
            if (srv && typeof srv.revision === 'number') storageRevision = srv.revision;
          } catch {}
        }
      }).catch(() => {});
    } catch {}
    try {
      Object.keys(localStorage).filter(k => k.startsWith('gooey_')).forEach(k => localStorage.removeItem(k));
    } catch {}
    renderSidebar();
    renderChat();
    updateTopbar();
    renderAttachBar();
    reRenderProjectsIfVisible();
  }
  function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => save(), 300);
  }

  // --- Models ---
  async function loadModels() {
    const sel = document.getElementById('model-select');
    const dsel = document.getElementById('detail-model-select');
    const fillModels = function(target) {
      if (!target) return;
      target.innerHTML = '';
      if (sel.options.length === 0) { target.innerHTML = '<option value="">No models</option>'; return; }
      Array.from(sel.options).forEach(function(o) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.textContent;
        target.appendChild(opt);
      });
      target.value = sel.value;
    };
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`);
      const data = await res.json();
      sel.innerHTML = '';
      if (!data.models || data.models.length === 0) { sel.innerHTML = '<option value="">No models</option>'; if (dsel) fillModels(dsel); return; }
      data.models.forEach(m => { const o = document.createElement('option'); o.value = m.name; o.textContent = m.name; sel.appendChild(o); });
      const saved = localStorage.getItem('gooey_model');
      if (saved && data.models.some(m => m.name === saved)) sel.value = saved;
      sel.onchange = () => localStorage.setItem('gooey_model', sel.value);
      if (dsel) {
        fillModels(dsel);
        dsel.onchange = () => { sel.value = dsel.value; localStorage.setItem('gooey_model', dsel.value); };
      }
    } catch {
      sel.innerHTML = '<option value="">Cannot reach Ollama</option>';
      if (dsel) fillModels(dsel);
    }
  }

  // --- Projects ---
  function createProject() {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
    projects[id] = { id, name: 'New project', instructions: '', kbFiles: {}, created: Date.now() };
    save();
    renderSidebar();
    openProjectDetail(id);
  }

  function openProjectSettings() {
    if (activeProjectId && projects[activeProjectId]) openProjectDetail(activeProjectId);
  }

  function editProjectById(id) {
    if (projects[id]) openProjectDetail(id);
  }

  function deleteProject(id) {
    showDialog({
      title: 'Delete project',
      message: 'Delete "' + (projects[id] ? projects[id].name : 'this project') + '" and all its chats?',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: function() { doDeleteProject(id); }
    });
  }

  function doDeleteProject(id) {
    abortIfStreaming();
    Object.keys(conversations).forEach(cid => { if (conversations[cid].projectId === id) delete conversations[cid]; });
    delete projects[id];
    if (activeProjectId === id) { activeProjectId = null; activeChatId = null; }
    save();
    renderSidebar();
    renderChat();
    updateTopbar();
    reRenderProjectsIfVisible();
  }

  // --- Knowledge Base ---
  function getViewingProject() {
    return viewingProjectId && projects[viewingProjectId] ? projects[viewingProjectId] : null;
  }

  function commitProjectField() {
    debouncedSave();
    if (currentPage !== 'project-detail') {
      renderSidebar();
      updateTopbar();
    }
    reRenderProjectsIfVisible();
  }

  function handleKbUpload(files) {
    const proj = getViewingProject();
    if (!proj) return;
    Array.from(files).forEach(file => {
      if (file.size > 200 * 1024) { showDialog({ title: 'File too large', message: file.name + ' exceeds the 200KB limit.' }); return; }
      const reader = new FileReader();
      reader.onload = (e) => {
        proj.kbFiles = proj.kbFiles || {};
        proj.kbFiles[file.name] = { content: e.target.result, size: file.size };
        commitProjectField();
        renderKbFiles();
      };
      reader.readAsText(file);
    });
  }

  function renderKbFiles() {
    const c = document.getElementById('kb-files');
    const count = document.getElementById('detail-kb-count');
    const proj = getViewingProject();
    const files = proj ? (proj.kbFiles || {}) : {};
    if (count) count.textContent = Object.keys(files).length ? '(' + Object.keys(files).length + ')' : '';
    c.innerHTML = '';
    const names = Object.keys(files);
    if (!names.length) { c.innerHTML = '<span class="detail-muted">No knowledge base files.</span>'; return; }
    names.forEach(name => {
      const f = files[name];
      const sizeStr = f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B';
      const div = document.createElement('div');
      div.className = 'kb-file';
      div.innerHTML = `<span class="kb-name">${esc(name)}</span><span class="kb-size">${sizeStr}</span><button class="kb-remove" data-kb="${esc(name)}">&times;</button>`;
      c.appendChild(div);
    });
  }

  function getKnowledgeContext() {
    if (!activeProjectId || !projects[activeProjectId]) return '';
    const files = projects[activeProjectId].kbFiles || {};
    const names = Object.keys(files);
    if (names.length === 0) return '';
    let ctx = '\n\n--- Knowledge Base ---\n';
    names.forEach(n => { ctx += `\n### ${n}\n${files[n].content}\n`; });
    return ctx;
  }

  // --- Chat file attachments ---
  function handleChatFileUpload(fileList) {
    Array.from(fileList).forEach(file => {
      if (file.size > 5 * 1024 * 1024) { showDialog({ title: 'File too large', message: file.name + ' exceeds the 5MB limit.' }); return; }
      const isImage = IMAGE_TYPES.includes(file.type);
      const reader = new FileReader();
      reader.onload = (e) => {
        if (isImage) {
          chatAttachments.push({ name: file.name, base64: e.target.result.split(',')[1], size: file.size, isImage: true, mime: file.type || 'image/png' });
        } else {
          chatAttachments.push({ name: file.name, content: e.target.result, size: file.size, isImage: false });
        }
        renderAttachBar();
      };
      isImage ? reader.readAsDataURL(file) : reader.readAsText(file);
    });
  }

  function renderAttachBar() {
    ['attach-bar', 'detail-attach-bar'].forEach(function(id) {
      const bar = document.getElementById(id);
      if (!bar) return;
      bar.innerHTML = '';
      if (chatAttachments.length === 0) { bar.classList.remove('has-files'); return; }
      bar.classList.add('has-files');
      chatAttachments.forEach((f, i) => {
        const sizeStr = f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B';
        const preview = f.isImage ? `<img src="data:${esc(f.mime || 'image/png')};base64,${b64OrEmpty(f.base64)}">` : '';
        const chip = document.createElement('div');
        chip.className = 'attach-chip';
        chip.innerHTML = `${preview}<span class="attach-name">${esc(f.name)}</span><span class="attach-size">${sizeStr}</span><button class="attach-remove" data-attach="${i}">&times;</button>`;
        bar.appendChild(chip);
      });
    });
  }

  // --- Sidebar ---
  function renderSidebar() {
    const list = document.getElementById('sidebar-list');
    list.innerHTML = '';
    const all = Object.keys(conversations).sort((a, b) => chatIdNum(b) - chatIdNum(a));
    if (all.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = 'No chats yet.';
      list.appendChild(empty);
      return;
    }
    all.forEach(cid => {
      const c = conversations[cid];
      const div = document.createElement('div');
      div.className = 'sidebar-item' + (cid === activeChatId ? ' active' : '');
      div.dataset.chat = cid;
      div.innerHTML = `<span class="title">${esc(c.title)}</span><button class="chat-dots-btn" data-action="chat-menu" title="Options">⠸</button>`;
      list.appendChild(div);
    });
  }

  // --- Context menus (⠸) ---
  let renamingChatId = null;

  function positionMenu(anchorEl) {
    const menu = document.getElementById('chat-menu');
    const rect = anchorEl.getBoundingClientRect();
    const estH = Math.min(menu.scrollHeight, Math.round(window.innerHeight * 0.7));
    let top = rect.bottom + 6;
    if (top + estH > window.innerHeight - 8) top = Math.max(8, rect.top - estH - 6);
    const left = Math.min(rect.left, window.innerWidth - 220);
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.left = Math.max(8, left) + 'px';
    menu.classList.add('open');
  }

  function openChatMenu(cid, anchorEl) {
    const c = conversations[cid];
    if (!c) return;
    const menu = document.getElementById('chat-menu');
    const pids = Object.keys(projects).sort((a, b) => (projects[b].created || 0) - (projects[a].created || 0));
    let html = '<button class="chat-menu-item" data-action="rename-chat" data-cid="' + cid + '">Rename</button>';
    html += '<div class="chat-menu-caption">Add to project</div>';
    html += '<button class="chat-menu-item' + (c.projectId ? '' : ' on') + '" data-action="move-chat" data-cid="' + cid + '" data-pid="">None' + (c.projectId ? '' : ' &#10003;') + '</button>';
    pids.forEach(pid => {
      const on = c.projectId === pid;
      html += '<button class="chat-menu-item' + (on ? ' on' : '') + '" data-action="move-chat" data-cid="' + cid + '" data-pid="' + pid + '">' + esc(projects[pid].name) + (on ? ' &#10003;' : '') + '</button>';
    });
    html += '<button class="chat-menu-item danger" data-action="delete-chat-menu" data-cid="' + cid + '">Delete chat</button>';
    menu.innerHTML = html;
    positionMenu(anchorEl);
  }

  function openProjectMenu(pid, anchorEl) {
    if (!projects[pid]) return;
    const menu = document.getElementById('chat-menu');
    let html = '<button class="chat-menu-item" data-action="project-new-chat" data-pid="' + pid + '">New chat</button>';
    html += '<button class="chat-menu-item" data-action="project-edit" data-pid="' + pid + '">Edit project</button>';
    html += '<button class="chat-menu-item danger" data-action="project-delete" data-pid="' + pid + '">Delete project</button>';
    menu.innerHTML = html;
    positionMenu(anchorEl);
  }

  function closeChatMenu() {
    document.getElementById('chat-menu').classList.remove('open');
  }

  function promptRenameChat(cid) {
    renamingChatId = cid;
    const input = document.getElementById('rename-input');
    input.value = conversations[cid] ? (conversations[cid].title || '') : '';
    document.getElementById('rename-modal').classList.add('open');
    setTimeout(function() { input.focus(); input.select(); }, 50);
  }

  function applyRenameChat() {
    const input = document.getElementById('rename-input');
    const name = input.value.trim();
    if (renamingChatId && conversations[renamingChatId]) {
      if (name) { conversations[renamingChatId].title = name.slice(0, 80); conversations[renamingChatId].titleLocked = true; }
      save();
      renderSidebar();
      renderChat();
    }
    document.getElementById('rename-modal').classList.remove('open');
    renamingChatId = null;
  }

  function closeRenameModal() {
    document.getElementById('rename-modal').classList.remove('open');
    renamingChatId = null;
  }

  function moveChatToProject(cid, pid) {
    if (!conversations[cid]) return;
    conversations[cid].projectId = pid || null;
    if (activeChatId === cid) activeProjectId = pid || null;
    save();
    renderSidebar();
    renderChat();
    updateTopbar();
    reRenderProjectsIfVisible();
  }

  // --- App dialog (replaces browser alert/confirm) ---
  let dialogCallback = null;
  let dialogCancelCallback = null;
  let dialogOpen = false;
  let dialogQueue = [];

  function showDialog(opts) {
    if (dialogOpen) { dialogQueue.push(opts); return; }
    dialogOpen = true;
    document.getElementById('dialog-title').textContent = opts.title || 'gooey';
    document.getElementById('dialog-message').textContent = opts.message || '';
    const ok = document.getElementById('dialog-ok-btn');
    const cancel = document.getElementById('dialog-cancel-btn');
    ok.textContent = opts.confirmLabel || 'OK';
    ok.classList.toggle('danger', !!opts.danger);
    cancel.style.display = (opts.cancelLabel || opts.onConfirm || opts.onCancel) ? '' : 'none';
    cancel.textContent = opts.cancelLabel || 'Cancel';
    dialogCallback = opts.onConfirm || null;
    dialogCancelCallback = opts.onCancel || null;
    document.getElementById('dialog-modal').classList.add('open');
  }

  function closeDialog() {
    document.getElementById('dialog-modal').classList.remove('open');
    dialogOpen = false;
    dialogCallback = null;
    dialogCancelCallback = null;
    const next = dialogQueue.shift();
    if (next) showDialog(next);
  }

  function closeMobileSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
  }



  function updateTopbar() {
    const btn = document.getElementById('project-settings-btn');
    const title = document.getElementById('topbar-title');
    if (activeProjectId && projects[activeProjectId]) {
      btn.style.display = '';
      title.textContent = projects[activeProjectId].name;
    } else {
      btn.style.display = 'none';
      title.textContent = 'gooey';
    }
  }

  // --- Chat ---
  function newChat(projectId) {
    const pid = projectId || activeProjectId;
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
    conversations[id] = { id, title: 'New chat', messages: [], model: document.getElementById('model-select').value, projectId: pid || null };
    activeChatId = id;
    if (pid) activeProjectId = pid;
    chatAttachments = [];
    renderAttachBar();
    setStreamingUI(false);
    save();
    renderSidebar();
    renderChat();
    updateTopbar();
    closeMobileSidebar();
  }

  function switchChat(id) {
    activeChatId = id;
    lastRunPath = null;
    chatAttachments = [];
    renderAttachBar();
    setStreamingUI(isChatStreaming(id));
    if (conversations[id]?.projectId) activeProjectId = conversations[id].projectId;
    else if (conversations[id]) activeProjectId = null;
    renderSidebar();
    renderChat();
    updateTopbar();
    closeMobileSidebar();
    checkResumeOnSwitch();
  }

  function deleteChat(id) {
    const c = conversations[id];
    showDialog({
      title: 'Delete chat',
      message: 'Delete "' + (c ? c.title : 'this chat') + '"?',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: function() { doDeleteChat(id); }
    });
  }

  function doDeleteChat(id) {
    abortIfStreaming();
    delete conversations[id];
    if (activeChatId === id) activeChatId = null;
    save();
    renderSidebar();
    renderChat();
  }

  function formatTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (msgDay.getTime() === today.getTime()) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  function renderChat() {
    const inner = document.getElementById('chat-inner');
    if (!activeChatId || !conversations[activeChatId]) {
      const projMsg = activeProjectId && projects[activeProjectId]
        ? `<p>Start a new chat in <strong>${esc(projects[activeProjectId].name)}</strong></p>`
        : `<p>Local LLM chat powered by Ollama. Pick a model and start chatting, or create a project.</p>`;
      inner.innerHTML = `<div class="welcome"><h2>gooey</h2>${projMsg}</div>`;
      return;
    }
    const msgs = conversations[activeChatId].messages;
    if (msgs.length === 0) { inner.innerHTML = '<div class="welcome"><h2>gooey</h2><p>Ask me anything.</p></div>'; return; }
    inner.innerHTML = '';
    msgs.forEach((m, i) => {
      if (m.injected) return;
      const row = document.createElement('div');
      row.dataset.msgIdx = i;
      if (m.role === 'user') {
        row.className = 'message message-user';
        const userText = m.content.split('\n\n--- File:')[0];
        const fileMatches = m.content.match(/--- File: (.+?) ---/g);
        let badges = '';
        const badgeParts = [];
        if (fileMatches) {
          fileMatches.forEach(fm => {
            const name = fm.replace('--- File: ', '').replace(' ---', '');
            badgeParts.push(`<span class="attach-badge">&#128206; ${esc(name)}</span>`);
          });
        }
        if (m.images && m.images.length > 0) {
          for (let i = 0; i < m.images.length; i++) {
            const b64 = b64OrEmpty(m.images[i]);
            badgeParts.push(`<span class="attach-badge"><img src="data:image/png;base64,${b64}" style="width:14px;height:14px;border-radius:3px;vertical-align:middle;margin-right:3px" alt="img">image ${i + 1}</span>`);
          }
        }
        if (badgeParts.length > 0) {
          badges = '<div class="attach-badges">' + badgeParts.join('') + '</div>';
        }
        row.innerHTML = `<div class="bubble">${esc(userText)}${badges}</div>`;
        if (m.ts) { const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = formatTs(m.ts); time.style.textAlign = 'right'; row.appendChild(time); }
      } else {
        row.className = 'message message-assistant';
        const isLast = m === msgs[msgs.length - 1];
        const actions = isLast && msgs.length >= 2 ? '<div class="msg-actions"><button class="msg-action-btn" data-action="regenerate">&#8634; Regenerate</button><button class="msg-action-btn" data-action="copy-msg">Copy</button></div>' : '<div class="msg-actions"><button class="msg-action-btn" data-action="copy-msg">Copy</button></div>';
        const cleanContent = stripFileOps(m.content);
        row.innerHTML = `<div class="content">${renderMd(cleanContent)}</div>${actions}`;
        const contentEl = row.querySelector('.content');
        if (contentEl) contentEl.dataset.rawContent = m.content;
        const fileOps = parseFileOps(m.content);
        if (m.fileOps && m.fileOps.length) {
          renderStoredFileOps(m, row);
        } else if (fileOps.length > 0) {
          renderFileOps(fileOps, row);
        }
        if (m.searchCards && m.searchCards.length) m.searchCards.forEach((entry, ei) => row.appendChild(buildSearchCardEl(entry, ei)));
        if (m.ts) { const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = formatTs(m.ts); row.appendChild(time); }
      }
      inner.appendChild(row);
    });
    scrollBottom();
  }

  function isNearBottom() {
    const chat = document.getElementById('chat');
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 150;
  }
  function scrollBottom() {
    const chat = document.getElementById('chat');
    chat.scrollTop = chat.scrollHeight;
  }

  // --- Title generation ---
  let titleChip = null;
  let titleGenToken = 0;
  function showTitleChip() {
    if (titleChip && titleChip.isConnected) return;
    titleChip = null;
    titleChip = document.createElement('div');
    titleChip.className = 'title-status';
    titleChip.innerHTML = '<span class="title-spinner"></span><span>Naming chat...</span>';
    document.getElementById('chat-inner').appendChild(titleChip);
    scrollBottom();
  }
  function hideTitleChip() {
    if (titleChip) { titleChip.remove(); titleChip = null; }
  }

  async function generateTitle(conv, model) {
    if (conv.titleLocked) return;
    const firstUser = conv.messages.find(m => m.role === 'user' && !m.injected);
    if (!firstUser) return;
    const userText = firstUser.content.slice(0, 1500);
    const token = ++titleGenToken;
    showTitleChip();
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: `Generate a short 3-5 word title for this conversation. Reply with ONLY the title, nothing else.\n\nUser: ${userText}`, stream: false, options: { temperature: 0.3, num_predict: 20 } })
      });
      const data = await res.json();
      if (data.response) {
        if (conv.messages && conv.messages.length) {
          conv.title = data.response.trim().replace(/^["':\-]+|["':\-]+$/g, '').slice(0, 50);
          save();
          renderSidebar();
        }
      }
    } catch {}
    if (token === titleGenToken) hideTitleChip();
  }

  // --- Send / Stop ---
  function setStreamingUI(val) {
    const btn = document.getElementById('send-btn');
    if (val) {
      btn.textContent = '\u25A0';
      btn.classList.add('stop');
      btn.disabled = false;
    } else {
      btn.textContent = 'send';
      btn.classList.remove('stop');
      btn.disabled = false;
    }
  }

  function handleSendOrStop() {
    if (isChatStreaming(activeChatId)) {
      const ac = abortControllers[activeChatId];
      if (ac) ac.abort();
    } else {
      send();
    }
  }

  async function send(injectText, opts) {
    let streamChatId = activeChatId;
    let targetChatId = (opts && opts.chatId) || streamChatId;
    if (isChatStreaming(targetChatId)) {
      if (injectText == null) {
        // Stop semantics for this chat: abort and invalidate any pending resume
        const sac = abortControllers[targetChatId];
        if (sac) sac.abort();
        bumpResumeToken(targetChatId);
        endStreamState(targetChatId, true);
        try { const loader = document.getElementById('gooey-loading'); if (loader) loader.remove(); } catch {}
        return;
      } else {
        return;
      }
    }
    const input = document.getElementById('input');
    const text = (injectText != null ? injectText : input.value).trim();
    if (!text) return;
    const model = document.getElementById('model-select').value;
    if (!model) {
      if (injectText != null) return;
      showDialog({ title: 'No model', message: 'Select a model first.' });
      return;
    }

    const useTarget = !!(opts && opts.chatId);
    const showInDom = !useTarget || targetChatId === streamChatId;

    let conv;
    if (useTarget) {
      conv = conversations[targetChatId];
      if (!conv) return;
    } else {
      if (!activeChatId || !conversations[activeChatId]) newChat();
      streamChatId = activeChatId;
      targetChatId = activeChatId;
      conv = conversations[activeChatId];
    }
    const entryToken = resumeToken(targetChatId);

    // Drop a dangling, aborted assistant message (no content, no pending ops) left by a previous send
    if (injectText == null && conv.messages.length) {
      const lastAborted = conv.messages[conv.messages.length - 1];
      if (lastAborted.role === 'assistant' && !(lastAborted.content || '').trim() && !(lastAborted.fileOps || []).length && !(lastAborted.searchCards || []).length && !lastAborted.resumePending) {
        conv.messages.pop();
        if (showInDom) renderChat();
      }
    }

    // Mark this chat as streaming synchronously to prevent double-send into it
    streamingChats[targetChatId] = true;

    let userContent = text;
    const images = [];
    if (injectText == null && chatAttachments.length > 0) {
      let attachCtx = '';
      chatAttachments.forEach(f => {
        if (f.isImage) { images.push(f.base64); }
        else { attachCtx += `\n\n--- File: ${f.name} ---\n${f.content}\n--- End: ${f.name} ---`; }
      });
      userContent = text + attachCtx;
    }
    const userMsg = { role: 'user', content: userContent, images: images.length > 0 ? images.slice() : undefined, ts: Date.now(), injected: (opts && opts.injected) || undefined };
    conv.messages.push(userMsg);
    if (!useTarget) {
      conv.model = model;
      if (!conv.title || conv.title === 'New chat') conv.title = text.slice(0, 40) || 'New chat';
      save();
      renderSidebar();
    }
    if (showInDom) renderChat();

    // Fire title gen in parallel (don't await)
    if (!useTarget) {
      const isFirst = conv.messages.filter(m => m.role === 'user' && !m.injected).length === 1;
      if (isFirst) generateTitle(conv, model);
    }

    if (injectText == null) {
      input.value = '';
      chatAttachments = [];
      renderAttachBar();
      autoResize(input);
    }
    if (showInDom) setStreamingUI(true);

    conv.messages.push({ role: 'assistant', content: '', ts: Date.now() });
    const myMsgIdx = conv.messages.length - 1;
    // Append assistant message element directly
    const chatInner = document.getElementById('chat-inner');
    let contentEl = null;
    if (showInDom) {
      const row = document.createElement('div');
      row.className = 'message message-assistant';
      row.dataset.msgIdx = myMsgIdx;
      row.innerHTML = '<div class="content"></div>';
      chatInner.appendChild(row);
      contentEl = row.querySelector('.content');
      // Add loader
      const loaderDiv = document.createElement('div');
      loaderDiv.className = 'message message-assistant';
      loaderDiv.id = 'gooey-loading';
      loaderDiv.innerHTML = '<div class="gooey-loader"><div class="gooey-ball"></div><div class="gooey-ball"></div><div class="gooey-ball"></div></div>';
      chatInner.appendChild(loaderDiv);
      scrollBottom();
    }
    let firstToken = true;
    let chunkCount = 0;

    function updateContent(c) {
      if (activeChatId !== streamChatId) return;
      const targetEl = contentEl && contentEl.isConnected ? contentEl : (showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"] .content') : null);
      if (targetEl) { targetEl.dataset.rawContent = c; targetEl.innerHTML = renderMd(stripFileOps(c)); }
    }

    let streamRenderTimer = null;
    function scheduleStreamRender() {
      if (streamRenderTimer) return;
      const scheduledIdx = conv.messages.length - 1;
      streamRenderTimer = setTimeout(function() {
        streamRenderTimer = null;
        const targetMsg = conv.messages[scheduledIdx];
        if (!targetMsg || !targetMsg.content) return;
        let targetEl = contentEl;
        if ((!targetEl || !targetEl.isConnected) && showInDom) {
          targetEl = chatInner.querySelector('.message-assistant[data-msg-idx="' + scheduledIdx + '"] .content') || null;
        }
        if (targetEl) { targetEl.dataset.rawContent = targetMsg.content; targetEl.innerHTML = renderMd(stripFileOps(targetMsg.content)); }
        if (isNearBottom() && showInDom) scrollBottom();
      }, 40);
    }

    let ac = new AbortController();
    abortControllers[targetChatId] = ac;
    let timedOut = false;
    let abortExited = false;
    const apiTimeout = setTimeout(() => { timedOut = true; ac.abort(); }, 180000);

    const apiMessages = [];
    const sandboxPrompt = `You are a helpful local assistant. For ordinary chat, greetings, and questions you can already answer, reply normally — the sandbox tools below are optional extras, and you should never discuss or apologize for them unless the user asks. Keep answers clear and direct.\nPersonal style: be concise and warm with a sense of humor — catch jokes (accidental or not) and play along. Always be friendly, complimentary, and nice, but stay straight with the user — say what you really think instead of sugarcoating. Make small decisions yourself; check with the user before big ones. Trust the user but push back when something looks wrong; when unsure, search (info file, chats, or web) before guessing.\n\nEXTRA INFO FILE: the user keeps knowledge you don't have in the file extra-info.md. Whenever a question relates to that knowledge, read it without any approval — results are injected automatically: everything in extra-info.md describes the person you are talking to right now (their name, age, device, projects). When the user asks about "my name/age/etc.", those facts ARE about them — never treat the file's person as a third party, never withhold or refuse well-known stored facts, and never act like the user isn't the person the file describes.
HARD RULE: for questions about the user's OWN personal facts (his name, age, device, setup, projects, or preferences), the app automatically places the stored facts in your context right before you reply — answer directly from them and do NOT emit <search_info>/<read_info> for those; they are already right in front of you. The tags below exist for OTHER knowledge in the file you want to look up, and for truncation the app recovers your intent anyway, but never invent a personal fact.\n<search_info>keywords</search_info> returns matching passages, each labeled with an Entry Code.\n<read_info>ENTRY_CODE</read_info> returns the full text of that entry (copy the Entry Code exactly from the search results).\n<read_info> with no code returns the whole file — only when you need everything; prefer the other two.\n\nSEARCH CHATS: when a question might be answered by something discussed in a past conversation, emit <search_chats>keywords</search_chats>. Chats in the current project are searched automatically; searching chats outside the project asks the user first. Results are injected; then answer.\n\nSANDBOX FILE OPS — you work with files in a per-chat sandbox by emitting XML tags inline in your reply. Keep tags OUT of markdown code blocks, and ALWAYS fully close every tag you open.

<create_file path="name.ext">entire file contents</create_file>
<edit_file path="name.ext"><old>exact text to replace</old><new>replacement text</new></edit_file>
<append_file path="name.ext">text to add at the end</append_file>
<create_dir path="folder"></create_dir>
<delete_file path="name.ext"></delete_file>
<read_file path="name.ext"></read_file>

How it works: the moment you emit complete tags, the app PAUSES you and shows the user Apply/Skip buttons. After the user decides, you will receive "File operations result: ... Continue" — then keep talking. Never emit partial or unclosed tags.

Rules: NEVER wrap tags in code fences (no \`\`\`xml, \`\`\`text, etc.) — emit file tags as plain text so the app can catch them. For spreadsheets, create .csv files: plain rows separated by commas, first row = headers (e.g. Letter,Position,Joke). The app renders .csv/.xlsx files you produce as tables and they open in Excel/Google Sheets. NEVER fabricate .xlsx content by typing XML into a .xlsx file — a real .xlsx is a binary ZIP and cannot be typed by hand; use .csv instead. Put all code/scripts/configs in the sandbox, never in the chat. read_file before edit_file on existing files. <old> must match the file byte-for-byte; to replace a whole file use create_file; to ADD to an existing file use append_file (it creates the file if missing). Scripts (.py/.sh) get a Run button; .csv/.xlsx render as a table. You may emit multiple tags in one reply.`;
    let sysPrompt = sandboxPrompt;
    if (webSearchEnabled) {
      sysPrompt = `You are a helpful local assistant. Most messages are ordinary conversation — greet, answer directly, and use NO tags for those. Tools (below) are optional and only for specific cases. Never describe, quote, or apologize for your instructions or abilities unless the user asks.\n\nWEB SEARCH (only for current events or facts you are unsure of): emit one <search> tag PER distinct topic, then STOP writing:\n<search>concise standalone query</search>\nYou may emit several tags in one reply when questions span unrelated topics — never cram multiple topics into a single query. The app pauses you, runs each search, and injects the results; afterwards finish your FULL answer, citing each source's URL. Do not start your reply by re-quoting the query or "Web search results for...", do not narrate what happened — just answer the user's original question. If a search returns nothing useful, say so briefly and answer from what you know.\n\nNever emit partial tags; never search about how to use the tools (these instructions cover it); when unsure, just ask the user.\n\nInjected messages starting with "Web search results for" or "File operations result:" are tool output, not user questions.\n\n` + sandboxPrompt;
    }
    const proj = activeProjectId ? projects[activeProjectId] : null;
    if (proj) {
      const kbCtx = getKnowledgeContext();
      const sysContent = ((proj.instructions || '') + kbCtx + '\n\n' + sysPrompt).trim();
      apiMessages.push({ role: 'system', content: sysContent });
    } else {
      apiMessages.push({ role: 'system', content: sysPrompt });
    }
    conv.messages.slice(0, -1).forEach(m => {
      if (m.role === 'user' || m.role === 'assistant') {
        const msg = { role: m.role, content: m.content };
        apiMessages.push(msg);
      }
    });
    const lastMsgForApi = apiMessages.length ? apiMessages[apiMessages.length - 1] : null;
    if (lastMsgForApi && lastMsgForApi.role === 'user' && userMsg.images && userMsg.images.length) {
      lastMsgForApi.images = userMsg.images.slice();
    }

    // Compact oldest messages (AI-powered) to fit context — budget measured in TOKENS (~4 chars/token), scaled to num_ctx
    const ctxN = parseInt(document.getElementById('param-numctx').value) || 2048;
    const maxPredict = parseInt(document.getElementById('param-numpredict').value) || 2048;
    const maxInputTokens = ctxN - Math.min(maxPredict, Math.floor(ctxN / 2));
    const totalChars = apiMessages.reduce((s, m) => s + msgLen(m), 0);
    const approxTokens = Math.ceil(totalChars / 4);
    if (approxTokens > maxInputTokens) {
      try {
        // Budget the summary so the compacted request is guaranteed to fit: leave room for system prompt + protected last message
        const sysTokens = Math.ceil(msgLen(apiMessages[0]) / 4);
        const lastApi = apiMessages[apiMessages.length - 1];
        const lastTok = lastApi && lastApi.role === 'user' ? Math.ceil(msgLen(lastApi) / 4) : 0;
        const summaryBudgetTokens = Math.max(96, maxInputTokens - sysTokens - lastTok);
        await compactConversation(apiMessages, model, conv.messages[conv.messages.length - 2], summaryBudgetTokens);
      } catch {
        // Fallback: drop oldest pairs if AI compaction fails
        let tc = apiMessages.reduce((s, m) => s + msgLen(m), 0);
        while (Math.ceil(tc / 4) > maxInputTokens && apiMessages.length > 3) {
          const removed = apiMessages.splice(1, 2);
          tc -= removed.reduce((s, m) => s + msgLen(m), 0);
        }
      }
      // Final safety: terminate unconditionally. Compute overflow once; trim or drop the summary; never loop.
      const tc2 = apiMessages.reduce((s, m) => s + msgLen(m), 0);
      const overflowTokens = Math.ceil(tc2 / 4) - maxInputTokens;
      if (overflowTokens > 0) {
        const sumIdx = apiMessages.findIndex(m => typeof m.content === 'string' && m.content.startsWith('[AI-SUMMARY]'));
        if (sumIdx !== -1) {
          const sumMsg = apiMessages[sumIdx];
          const desired = sumMsg.content.length - Math.ceil(overflowTokens * 4);
          if (desired <= 64 && apiMessages.length > 2) {
            apiMessages.splice(sumIdx, 1);
          } else if (desired <= 64) {
            sumMsg.content = sumMsg.content.slice(0, Math.max(1, desired));
          } else {
            sumMsg.content = sumMsg.content.slice(0, desired);
          }
        }
      }
    }

    // Deterministic personal-fact fallback: if the user asks about their own stored facts,
    // inject the extra-info.md results into context before the API call — never rely on guessing.
    if (injectText == null) {
      const pq = detectPersonalQuery(text);
      if (pq) {
        try {
          const infoStr = await fetchInfoForInject(pq, ac.signal);
          if (infoStr) apiMessages.push({ role: 'user', content: infoStr });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
        }
      }
    }

    try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: apiMessages, stream: true, options: getParams() }),
        signal: ac.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errMsg = `Ollama error (${res.status})`;
        try { const errJson = JSON.parse(errText); if (errJson.error) errMsg = errJson.error; } catch {}
        throw new Error(errMsg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamError = null;

      outer: while (true) {
        let chunk;
        try { chunk = await reader.read(); } catch (readErr) {
          if (readErr && readErr.name === 'AbortError') { abortExited = true; break; }
          throw readErr;
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.error) { streamError = obj.error; break outer; }
          if (obj.message && obj.message.content) {
            if (firstToken) {
              const loader = document.getElementById('gooey-loading');
              if (loader) loader.remove();
              firstToken = false;
            }
            conv.messages[myMsgIdx].content += obj.message.content;
            scheduleStreamRender();
            if (++chunkCount % 10 === 0) debouncedSave();

            // Check for complete file ops mid-stream
            const fullContent = conv.messages[conv.messages.length - 1].content;
            const completeOps = detectCompleteFileOps(fullContent);
            if (completeOps.length > 0) {
              // Pause: abort stream, persist ops for re-action, keep history tag-free
              clearTimeout(apiTimeout);
              if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
              ac.abort();
              const lastMsgSl = conv.messages[myMsgIdx];
              lastMsgSl.fileOps = completeOps.map(op => ({ type: op.type, path: op.path, content: op.content, old: op.old, new: op.new, preview: (op.content || '').slice(0, 300), status: 'pending' }));
              lastMsgSl.resumePending = true;
              lastMsgSl.content = stripToolTags(stripFileOpsFromContent(fullContent));
              updateContent(lastMsgSl.content);
              save();
              endStreamState(targetChatId, showInDom);
              if (showInDom) {
                const pausedRow = chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]');
                if (pausedRow) renderStoredFileOps(lastMsgSl, pausedRow);
              }
              return; // Exit send() — apply/skip any op to resume
            }
            // Check for complete web search tags mid-stream
            const searchTags = detectCompleteSearchTags(fullContent);
            if (searchTags.length > 0) {
              clearTimeout(apiTimeout);
              if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
              ac.abort();
              const cleanContent = stripToolTags(fullContent);
              conv.messages[myMsgIdx].content = cleanContent;
              updateContent(cleanContent);
              const lastRow = showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]') : null;
              const token = bumpResumeToken(targetChatId);
              save();
              endStreamState(targetChatId, showInDom);
              void runSearchAndResume(searchTags, lastRow, streamChatId, token);
              return; // Exit send() — runSearchAndResume resumes the stream
            }
            // Check for complete info-file tags mid-stream
            const infoTags = detectCompleteInfoTags(fullContent);
            if (infoTags.length > 0) {
              clearTimeout(apiTimeout);
              if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
              ac.abort();
              const itag = infoTags[infoTags.length - 1];
              const cleanInfo = stripToolTags(fullContent);
              conv.messages[myMsgIdx].content = cleanInfo;
              updateContent(cleanInfo);
              const lastRow = showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]') : null;
              const token = bumpResumeToken(targetChatId);
              save();
              endStreamState(targetChatId, showInDom);
              void runInfoAndResume(itag, lastRow, streamChatId, token);
              return; // Exit send() — runInfoAndResume resumes the stream
            }
            // Check for complete chat-search tags mid-stream
            const chatSearchTags = detectCompleteChatSearchTags(fullContent);
            if (chatSearchTags.length > 0) {
              clearTimeout(apiTimeout);
              if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
              ac.abort();
              const chatQuery = chatSearchTags[chatSearchTags.length - 1];
              const cleanChat = stripToolTags(fullContent);
              conv.messages[myMsgIdx].content = cleanChat;
              updateContent(cleanChat);
              const lastRow = showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]') : null;
              const token = bumpResumeToken(targetChatId);
              save();
              endStreamState(targetChatId, showInDom);
              void runChatSearchAndResume(chatQuery, lastRow, streamChatId, token);
              return; // Exit send() — runChatSearchAndResume resumes the stream
            }
          }
        }
      }
      // Handle leftover partial line that arrived without a trailing newline
      if (buffer.trim()) {
        let obj;
        try { obj = JSON.parse(buffer); } catch {}
        if (obj) {
          if (obj.error) { streamError = obj.error; }
          else if (obj.message && obj.message.content) {
            if (firstToken) {
              const loader = document.getElementById('gooey-loading');
              if (loader) loader.remove();
              firstToken = false;
            }
            conv.messages[myMsgIdx].content += obj.message.content;
            scheduleStreamRender();
            if (++chunkCount % 10 === 0) debouncedSave();
          }
        }
      }
      if (streamError) throw new Error(streamError);
      const lastMsgE = conv.messages[conv.messages.length - 1];
      if (abortExited) {
        if (lastMsgE && conv.messages[myMsgIdx] === lastMsgE && lastMsgE.role === 'assistant') {
          const pendingOpsE = persistAbortedFileOps(lastMsgE);
          if (!lastMsgE.content) lastMsgE.content += timedOut ? '*[stopped: timed out]*' : '*[stopped]*';
          else lastMsgE.content += timedOut ? '\n\n*[stopped: timed out]*' : '\n\n*[stopped]*';
          updateContent(lastMsgE.content);
          if (pendingOpsE.length && showInDom) {
            const rowE = chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]');
            if (rowE) renderStoredFileOps(lastMsgE, rowE);
          }
          save();
        }
        renderSidebar();
        if (activeChatId === streamChatId) renderChat();
        return;
      }
      if (lastMsgE && conv.messages[myMsgIdx] === lastMsgE && lastMsgE.role === 'assistant') {
        // Strip leftover/incomplete search + info + chat-search tags so no XML leaks into markdown
        const rawContent = lastMsgE.content || '';
        const leftoverSearch = detectCompleteSearchTags(rawContent);
        const leftoverInfo = detectCompleteInfoTags(rawContent);
        const leftoverChatSearch = detectCompleteChatSearchTags(rawContent);
        const cleanSearch = stripToolTags(rawContent);
        lastMsgE.content = cleanSearch;
        updateContent(cleanSearch);
        const rawOps = parseFileOps(lastMsgE.content);
        if (rawOps.length) {
          lastMsgE.fileOps = rawOps.map(o => ({ type: o.type, path: o.path, content: o.content, old: o.old, new: o.new, preview: (o.content || '').slice(0, 300), status: 'pending' }));
          lastMsgE.resumePending = true;
          lastMsgE.content = stripFileOpsFromContent(lastMsgE.content);
          updateContent(lastMsgE.content);
        }
        if (leftoverSearch.length > 0) {
          const lastRow = showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]') : null;
          if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
          save();
          endStreamState(targetChatId, showInDom);
          const token = bumpResumeToken(targetChatId);
          void runSearchAndResume(leftoverSearch, lastRow, streamChatId, token);
          return;
        }
        if (leftoverInfo.length > 0) {
          const itag = leftoverInfo[leftoverInfo.length - 1];
          const lastRow = showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]') : null;
          if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
          save();
          endStreamState(targetChatId, showInDom);
          const token = bumpResumeToken(targetChatId);
          void runInfoAndResume(itag, lastRow, streamChatId, token);
          return;
        }
        if (leftoverChatSearch.length > 0) {
          const chatQuery = leftoverChatSearch[leftoverChatSearch.length - 1];
          const lastRow = showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]') : null;
          if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
          save();
          endStreamState(targetChatId, showInDom);
          const token = bumpResumeToken(targetChatId);
          void runChatSearchAndResume(chatQuery, lastRow, streamChatId, token);
          return;
        }
        // Recover intent from TRUNCATED / unclosed tool tags (cut-off streams)
        const partials = detectUnclosedToolTags(rawContent);
        if (partials.length > 0) {
          const p = partials[partials.length - 1];
          lastMsgE.content = stripFileOpsFromContent(cleanSearch);
          updateContent(lastMsgE.content);
          const lastRow = showInDom ? chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]') : null;
          if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
          save();
          endStreamState(targetChatId, showInDom);
          const token = bumpResumeToken(targetChatId);
          if (p.kind === 'chat') void runChatSearchAndResume(p.query, lastRow, streamChatId, token);
          else void runInfoAndResume({ kind: p.kind, query: p.query }, lastRow, streamChatId, token);
          return;
        }
        if (firstToken && !String(lastMsgE.content || '').trim()) {
          const ldrE = document.getElementById('gooey-loading');
          if (ldrE) ldrE.remove();
          lastMsgE.content = '*[no response]*';
          updateContent(lastMsgE.content);
        }
      }
      if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
      save();
      renderSidebar();
      if (activeChatId === streamChatId) renderChat();
    } catch (e) {
      if (e.name === 'AbortError') {
        const lastMsg = conv.messages[conv.messages.length - 1];
        if (conv.messages[myMsgIdx] === lastMsg && lastMsg && lastMsg.role === 'assistant') {
          const loader = document.getElementById('gooey-loading');
          if (loader) loader.remove();
          const pendingOpsC = persistAbortedFileOps(lastMsg);
          if (!lastMsg.content) lastMsg.content += timedOut ? '*[stopped: timed out]*' : '*[stopped]*';
          else lastMsg.content += timedOut ? '\n\n*[stopped: timed out]*' : '\n\n*[stopped]*';
          updateContent(lastMsg.content);
          if (pendingOpsC.length && showInDom) {
            const rowC = chatInner.querySelector('.message-assistant[data-msg-idx="' + myMsgIdx + '"]');
            if (rowC) renderStoredFileOps(lastMsg, rowC);
          }
          save();
          if (showInDom) {
            const allAssistant = chatInner.querySelectorAll('.message-assistant');
            allAssistant.forEach(el => {
              if (!el.querySelector('.gooey-loader') && !el.querySelector('.content')?.textContent) {
                const idx = el.dataset.msgIdx;
                if (idx === undefined || !/^\d+$/.test(idx)) return;
                const m = conv.messages ? conv.messages[Number(idx)] : null;
                const hasPending = m && (((m.fileOps || []).some(o => (o.status || 'pending') === 'pending')) || ((m.searchCards || []).length > 0));
                if (!hasPending) el.remove();
              }
            });
          }
        } else {
          save();
        }
      } else {
        const errMsg = e.message || 'failed to reach Ollama';
        const lastErrMsg = conv.messages[myMsgIdx] || conv.messages[conv.messages.length - 1];
        const ldrErr = document.getElementById('gooey-loading');
        if (ldrErr) ldrErr.remove();
        if (lastErrMsg) {
          lastErrMsg.content = `*Error: ${errMsg}*`;
          updateContent(lastErrMsg.content);
        }
        save();
      }
    } finally {
      clearTimeout(apiTimeout);
      if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
      if (resumeToken(targetChatId) === entryToken) {
        endStreamState(targetChatId, showInDom);
      }
    }
  }

  // --- File operations from model ---
  function parseFileOps(content) {
    return extractFileOps(content);
  }

  function renderFileOps(ops, container) {
    const icons = { create_file: '&#128196;', edit_file: '&#9998;', create_dir: '&#128193;', delete_file: '&#128465;', read_file: '&#128269;', append_file: '&#10133;' };
    const labels = { create_file: 'Create file', edit_file: 'Edit file', create_dir: 'Create folder', delete_file: 'Delete', read_file: 'Read file', append_file: 'Append' };
    ops.forEach((op, i) => {
      const card = document.createElement('div');
      card.className = 'file-op-card';
      card.dataset.opIdx = i;
      const preview = op.content ? `<div class="file-op-preview">${esc(op.content.slice(0, 800))}${op.content.length > 800 ? '\n...' : ''}</div>` : '';
      card.innerHTML = `
        <div class="file-op-header">
          <span class="op-icon">${icons[op.type] || '&#128196;'}</span>
          <span class="op-label">${labels[op.type] || op.type}</span>
          <span class="op-path">${esc(op.path)}</span>
        </div>
        ${preview}
        <div class="file-op-actions">
          <button class="file-op-btn approve" data-approve="${i}">Apply</button>
          <button class="file-op-btn reject" data-reject="${i}">Skip</button>
        </div>
        <div class="file-op-status"></div>`;
      container.appendChild(card);
    });
  }

  function renderStoredFileOps(msg, row) {
    const icons = { create_file: '&#128196;', edit_file: '&#9998;', create_dir: '&#128193;', delete_file: '&#128465;', read_file: '&#128269;', append_file: '&#10133;' };
    const labels = { create_file: 'Create file', edit_file: 'Edit file', create_dir: 'Create folder', delete_file: 'Delete', read_file: 'Read file', append_file: 'Append' };
    (msg.fileOps || []).forEach((op, i) => {
      const pending = (op.status || 'pending') === 'pending';
      const card = document.createElement('div');
      card.className = 'file-op-card';
      const preview = op.preview ? `<div class="file-op-preview">${esc(op.preview)}${op.preview.length >= 300 ? '\n...' : ''}</div>` : '';
      const doneCls = op.status === 'skipped' ? '' : (op.status === 'error' ? 'error' : 'done');
      const statusText = op.status === 'skipped' ? 'Skipped' : (op.status === 'error' ? `Error: ${esc(op.errMessage || 'failed')}` : 'Done');
      const footer = pending
        ? `<div class="file-op-actions">
          <button class="file-op-btn approve" data-apply-op="${i}" data-op-msg="${row.dataset.msgIdx}">Apply</button>
          <button class="file-op-btn reject" data-skip-op="${i}" data-op-msg="${row.dataset.msgIdx}">Skip</button>
        </div>
        <div class="file-op-status"></div>`
        : `<div class="file-op-status ${doneCls}">${statusText}</div>`;
      card.innerHTML = `
        <div class="file-op-header">
          <span class="op-icon">${icons[op.type] || '&#128196;'}</span>
          <span class="op-label">${labels[op.type] || op.type}</span>
          <span class="op-path">${esc(op.path)}</span>
        </div>
        ${preview}
        ${footer}`;
      row.appendChild(card);
    });
    if (msg.resumePending && (msg.fileOps || []).some(op => (op.status || 'pending') === 'pending')) {
      const note = document.createElement('div');
      note.className = 'file-op-status';
      note.textContent = 'Model paused — approve or skip to continue';
      row.appendChild(note);
    }
  }

  async function executeFileOpWithUI(op, card) {
    const statusEl = card ? card.querySelector('.file-op-status') : null;
    try {
      if (op.type === 'read_file') {
        const res = performFileOp(op);
        const data = res && (await res);
        if (data && data.value) throw new Error(data.value);
        if (data && data.notFound) {
          if (statusEl) { statusEl.textContent = 'File not found: ' + op.path; statusEl.className = 'file-op-status error'; }
          return 'File not found: ' + op.path;
        }
        if (statusEl) { statusEl.textContent = `Read (${data.size || 0} bytes)`; statusEl.className = 'file-op-status done'; }
        refreshFileTree();
        return null;
      }
      const err = await performFileOp(op);
      if (err) throw new Error(err);
      if (op.type === 'create_dir') {
        if (statusEl) { statusEl.textContent = 'Created'; statusEl.className = 'file-op-status done'; }
      } else if (op.type === 'delete_file') {
        if (statusEl) { statusEl.textContent = 'Deleted'; statusEl.className = 'file-op-status done'; }
      } else if (statusEl) { statusEl.textContent = 'Saved'; statusEl.className = 'file-op-status done'; }
      return null;
    } catch (e) {
      if (statusEl) { statusEl.textContent = `Error: ${e.message}`; statusEl.className = 'file-op-status error'; }
      return e.message || 'failed';
    }
  }

  // Wire up file op buttons via event delegation on chat
  document.getElementById('chat').addEventListener('click', function(e) {
    const approveBtn = e.target.closest('[data-approve]');
    if (approveBtn) {
      const card = approveBtn.closest('.file-op-card');
      const idx = Number(approveBtn.dataset.approve);
      const row = card.closest('.message-assistant');
      const content = row?.querySelector('.content');
      if (!content) return;
      const convNow = activeChatId ? conversations[activeChatId] : null;
      const msgIdx = row ? Number(row.dataset.msgIdx) : NaN;
      const storedMsg = row && convNow && convNow.messages ? convNow.messages[msgIdx] : null;
      const raw = content.dataset.rawContent || (typeof content.rawContent === 'string' ? content.rawContent : (storedMsg && storedMsg.content ? storedMsg.content : ''));
      const ops = parseFileOps(raw || content.textContent);
      if (ops[idx]) {
        ops[idx]._idx = idx;
        if (storedMsg && !storedMsg.fileOps) {
          storedMsg.content = cleanToolLeftovers(storedMsg.content || '');
          storedMsg.fileOps = ops.map(o => ({ type: o.type, path: o.path, content: o.content, old: o.old, new: o.new, preview: (o.content || '').slice(0, 300), status: 'pending' }));
          storedMsg.resumePending = true;
          save();
        }
        const storedOp = storedMsg && storedMsg.fileOps ? storedMsg.fileOps[idx] : null;
        approveBtn.disabled = true;
        approveBtn.closest('.file-op-actions').querySelector('[data-reject]').disabled = true;
        // Persist the REAL outcome from the awaited result, then resume the model (#81)
        executeFileOpWithUI(ops[idx], card).then(function(errMsg) {
          if (storedOp) {
            storedOp.status = errMsg ? 'error' : 'applied';
            if (errMsg) storedOp.errMessage = errMsg;
          }
          save();
          maybeResume(convNow, msgIdx);
        });
      }
      return;
    }
    const rejectBtn = e.target.closest('[data-reject]');
    if (rejectBtn) {
      const cardR = rejectBtn.closest('.file-op-card');
      const rowR = cardR ? cardR.closest('.message-assistant') : null;
      const convR = activeChatId ? conversations[activeChatId] : null;
      const msgIdxR = rowR ? Number(rowR.dataset.msgIdx) : NaN;
      const msgR = convR && convR.messages ? convR.messages[msgIdxR] : null;
      const idxR = Number(rejectBtn.dataset.reject);
      rejectBtn.disabled = true;
      const apprBtn = rejectBtn.closest('.file-op-actions').querySelector('[data-approve]');
      if (apprBtn) apprBtn.disabled = true;
      const statusElR = cardR ? cardR.querySelector('.file-op-status') : null;
      if (statusElR) { statusElR.textContent = 'Skipped'; statusElR.className = 'file-op-status'; }
      // Persist the skip and resume the model instead of only touching the DOM (#81)
      if (msgR && msgR.fileOps && msgR.fileOps[idxR] && (msgR.fileOps[idxR].status || 'pending') === 'pending') {
        msgR.fileOps[idxR].status = 'skipped';
        save();
        maybeResume(convR, msgIdxR);
      }
      return;
    }
  });

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (dialogOpen) { e.preventDefault(); closeDialog(); return; }
      e.preventDefault(); handleSendOrStop();
    }
    if (e.key === 'Escape') { closeSearch(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); toggleSearch(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); toggleFilePanel(); }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  // --- Utils ---
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;');
  }

  function b64OrEmpty(v) {
    return (typeof v === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(v)) ? v : '';
  }

  function safeUrl(u) {
    const s = String(u || '').trim();
    return /^(?:https?:\/\/|mailto:)/i.test(s) ? s : 'about:blank';
  }

  function exportChat() {
    if (!activeChatId || !conversations[activeChatId]) return;
    const msgs = conversations[activeChatId].messages;
    const text = msgs.filter(m => !m.injected).map(m => `**${m.role === 'user' ? 'You' : 'Assistant'}:**\n${m.content}${m.role === 'assistant' ? searchSources(m) : ''}`).join('\n\n---\n\n');
    const btn = document.getElementById('export-btn');
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Export', 1500);
    }).catch(() => {
      exportChatFile();
      btn.textContent = 'Downloaded!';
      setTimeout(() => btn.textContent = 'Export', 1500);
    });
  }

  // --- AI-powered conversation compaction ---
  function showCompactUI() {
    const banner = document.getElementById('compact-banner');
    banner.classList.add('active');
    const fill = document.getElementById('compact-progress-fill');
    fill.classList.add('indeterminate');
    fill.style.width = '';
  }
  function hideCompactUI() {
    const banner = document.getElementById('compact-banner');
    banner.classList.remove('active');
    const fill = document.getElementById('compact-progress-fill');
    fill.classList.remove('indeterminate');
    fill.style.width = '0%';
  }

  async function aiSummarizeWhole(messages, model, contextMsg, maxSummaryTokens) {
    const pick = messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '', images: m.images }));
    // Keep under model context: if too large, drop oldest non-summary entries
    let buf = pick;
    let chars = buf.reduce((s, m) => s + msgLen(m), 0);
    const ctxV = parseInt(document.getElementById('param-numctx').value) || 2048;
    const SUMMARY_LIMIT = ctxV * 3;
    while (chars > SUMMARY_LIMIT && buf.length > 2) {
      let dropIdx = 0;
      for (let i = 0; i < buf.length; i++) {
        if (msgLen(buf[i]) > msgLen(buf[dropIdx])) dropIdx = i;
      }
      const dropped = buf.splice(dropIdx, 1);
      chars -= msgLen(dropped[0]);
    }
    let contextNote = '';
    if (contextMsg) {
      const ctxText = (typeof contextMsg.content === 'string' ? contextMsg.content : '').slice(0, SUMMARY_LIMIT);
      buf.push({ role: 'user', content: '[CURRENT USER MESSAGE — FOR CONTEXT ONLY, DO NOT SUMMARIZE]\n' + ctxText });
      contextNote = '\n\nA message tagged [CURRENT USER MESSAGE] is appended last. Use it ONLY to understand what the user is asking right now so your summary emphasizes the most relevant earlier context. NEVER include, quote, echo, or summarize the contents of that message — summarize only the conversation ABOVE the tag.';
    }
    const sysMsg = {
      role: 'system',
      content: 'Summarize the ENTIRE conversation exchange below into a comprehensive summary. Preserve: file paths and filenames, code created/edited, decisions, requests in progress, and any details the user may reference later. Output a structured, readable summary of everything covered — not just the last messages. Be thorough but concise.' + contextNote
    };
    const to = withTimeout(120000);
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [sysMsg, ...buf], stream: false, options: { num_ctx: ctxV, temperature: 0.2, num_predict: Math.max(120, Math.min(600, maxSummaryTokens || 600)) } }),
        signal: to.signal
      });
      if (!res.ok) throw new Error('compaction failed');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.message?.content || '').trim();
      if (!text) throw new Error('empty summary');
      return text;
    } finally {
      to.cancel();
    }
    if (!res.ok) throw new Error('compaction failed');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const text = (data.message?.content || '').trim();
    if (!text) throw new Error('empty summary');
    return text;
  }

  async function compactConversation(apiMessages, model, currentMsg, summaryBudgetTokens) {
    showCompactUI();
    try {
      const system = apiMessages[0];
      const last = apiMessages[apiMessages.length - 1];
      // Protect the most recent user message (the one just sent) from compaction
      const protectLast = last && last.role === 'user';
      let rest = apiMessages.slice(1);
      if (protectLast) rest = rest.slice(0, -1);
      if (rest.length < 2) return;
      // Give the summarizer the current message as context only (never part of the summary)
      const isRealUser = currentMsg && currentMsg.role === 'user' && !currentMsg.injected;
      const summary = await aiSummarizeWhole(rest, model, isRealUser ? currentMsg : null, summaryBudgetTokens);
      let summaryContent = summary;
      // Safety cap so the compacted request fits in-context even if the model over-wrote
      if (summaryBudgetTokens && summaryBudgetTokens > 0) {
        const maxChars = Math.floor(summaryBudgetTokens * 4);
        if (summaryContent.length > maxChars) summaryContent = summaryContent.slice(0, maxChars);
      }
      apiMessages.length = 0;
      apiMessages.push(system, { role: 'user', content: '[AI-SUMMARY] ' + summaryContent });
      if (protectLast) apiMessages.push(last);
    } finally {
      hideCompactUI();
    }
  }

  // --- Model params ---
  // >>> PAGES_ROUTING <<<
  let currentPage = 'chat';
  let viewingProjectId = null;

  function showPage(p) {
    document.getElementById('projects-page').classList.remove('open');
    document.getElementById('detail-page').classList.remove('open');
    if (p === 'projects') document.getElementById('projects-page').classList.add('open');
    else if (p === 'project-detail') document.getElementById('detail-page').classList.add('open');
    currentPage = p;
  }

  function openProjectsPage() {
    renderProjectsPage();
    showPage('projects');
  }

  function renderProjectsPage() {
    const grid = document.getElementById('projects-grid');
    const empty = document.getElementById('projects-empty');
    const cornerBtn = document.getElementById('projects-new-btn');
    const ids = Object.keys(projects);
    if (!ids.length) {
      grid.style.display = 'none';
      empty.style.display = '';
      cornerBtn.style.display = 'none';
      return;
    }
    grid.style.display = '';
    cornerBtn.style.display = '';
    empty.style.display = 'none';
    ids.sort(function(a, b) { return Number(projects[b].created) - Number(projects[a].created); });
    grid.innerHTML = '';
    ids.forEach(function(pid) {
      const p = projects[pid];
      const chatCount = Object.values(conversations).filter(function(c) { return c.projectId === pid; }).length;
      const kbCount = Object.keys(p.kbFiles || {}).length;
      const card = document.createElement('div');
      card.className = 'project-card';
      card.setAttribute('data-project', pid);
      card.innerHTML =
        '<div class="project-card-head"><span class="title">' + esc(p.name) + '</span><button class="chat-dots-btn" data-action="open-project-menu" title="Options">⠸</button></div>' +
        '<div class="project-card-meta">' + chatCount + ' ' + (chatCount === 1 ? 'chat' : 'chats') + ' · ' + kbCount + ' ' + (kbCount === 1 ? 'file' : 'files') + '</div>' +
        '<div class="project-card-preview">' + (p.instructions ? esc(p.instructions.slice(0, 140)) : 'No instructions yet') + '</div>';
      grid.appendChild(card);
    });
  }

  function reRenderProjectsIfVisible() {
    if (currentPage === 'projects') renderProjectsPage();
  }

  function openProjectDetail(pid) {
    viewingProjectId = pid;
    renderProjectDetail();
    showPage('project-detail');
  }

  document.getElementById('projects-btn').addEventListener('click', openProjectsPage);
  document.getElementById('projects-back-btn').addEventListener('click', function() { showPage('chat'); });
  document.getElementById('projects-new-btn').addEventListener('click', createProject);
  document.getElementById('projects-empty-new-btn').addEventListener('click', createProject);
  document.getElementById('projects-grid').addEventListener('click', function(e) {
    if (e.target.closest('.chat-dots-btn')) return;
    const card = e.target.closest('.project-card');
    if (card) openProjectDetail(card.getAttribute('data-project'));
  });
  document.getElementById('detail-back-btn').addEventListener('click', function() { renderProjectsPage(); showPage('projects'); });
  function renderProjectDetail() {
    const pid = viewingProjectId;
    const p = projects[pid];
    if (!p) {
      viewingProjectId = null;
      document.getElementById('detail-title').value = '';
      document.getElementById('detail-instructions').value = '';
      renderKbFiles();
      const chatEl = document.getElementById('detail-chats');
      if (chatEl) chatEl.innerHTML = '';
      return;
    }
    document.getElementById('detail-title').value = p.name;
    document.getElementById('detail-instructions').value = p.instructions || '';
    renderKbFiles();
    const chats = Object.values(conversations).filter(function(c) { return c.projectId === pid; });
    chats.sort(function(a, b) { return chatIdNum(b.id) - chatIdNum(a.id); });
    const chatEl = document.getElementById('detail-chats');
    if (chats.length) {
      chatEl.innerHTML = '';
      chats.forEach(function(c) {
        const div = document.createElement('div');
        div.className = 'detail-chat-item';
        div.setAttribute('data-detail-chat', c.id);
        div.innerHTML = '<span class="title">' + esc(c.title || 'New chat') + '</span><button class="chat-dots-btn" data-action="open-chat-menu" title="Options">⠸</button>';
        chatEl.appendChild(div);
      });
    } else {
      chatEl.innerHTML = '<span class="detail-muted">No chats yet. Start one below.</span>';
    }
  }

  function startChatFromDetail() {
    const ta = document.getElementById('detail-input');
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    ta.value = '';
    ta.style.height = '';
    newChat(viewingProjectId);
    showPage('chat');
    document.getElementById('input').value = text;
    autoResize(document.getElementById('input'));
    send();
  }

  const detailInput = document.getElementById('detail-input');
  detailInput.addEventListener('input', function() { autoResize(this); });
  detailInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      startChatFromDetail();
    }
  });
  document.getElementById('detail-send-btn').addEventListener('click', startChatFromDetail);
  document.addEventListener('click', function(e) {
    if (e.target.closest('.chat-dots-btn')) return;
    const chatEl = e.target.closest('[data-detail-chat]');
    if (chatEl) {
      switchChat(chatEl.getAttribute('data-detail-chat'));
      showPage('chat');
    }
  });
  document.getElementById('detail-open-chat-btn').addEventListener('click', function() {
    const chats = Object.values(conversations).filter(function(c) { return c.projectId === viewingProjectId; });
    chats.sort(function(a, b) { return chatIdNum(b.id) - chatIdNum(a.id); });
    if (chats.length) switchChat(chats[0].id);
    else newChat(viewingProjectId);
    showPage('chat');
  });
  const addMenus = [
    { btn: document.getElementById('add-menu-btn'), menu: document.getElementById('add-menu') },
    { btn: document.getElementById('detail-add-menu-btn'), menu: document.getElementById('detail-add-menu') }
  ];

  function fillAddMenuRoot(menu) {
    menu.innerHTML =
      '<button class="add-menu-item" data-add="attach">Upload file</button>' +
      '<button class="add-menu-item" data-add="websearch">Web search <span class="add-menu-state">' + (webSearchEnabled ? 'on' : 'off') + '</span></button>' +
      '<button class="add-menu-item" data-add="project">Move chat to project</button>' +
      '<button class="add-menu-item" data-add="newchat">New chat</button>';
  }

  function closeAddMenus() {
    addMenus.forEach(function(pair) { pair.menu.classList.remove('open'); });
  }

  function positionAddMenu(pair) {
    pair.menu.style.top = '0px';
    pair.menu.style.left = '0px';
    const rect = pair.btn.getBoundingClientRect();
    const estH = pair.menu.scrollHeight;
    let top = rect.top - estH - 6;
    if (top < 8) top = rect.bottom + 6;
    if (top + estH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - estH - 8);
    pair.menu.style.top = top + 'px';
    pair.menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300)) + 'px';
  }

  function toggleAddMenu(pair) {
    closeAddMenus();
    if (!pair.menu.classList.contains('open')) fillAddMenuRoot(pair.menu);
    pair.menu.classList.add('open');
    positionAddMenu(pair);
  }

  function fillAddMenuProjects(menu) {
    const pids = Object.keys(projects).sort((a, b) => (projects[b].created || 0) - (projects[a].created || 0));
    let html = '<div class="add-menu-header">Choose project <button class="add-menu-back" data-add="root">&#8592;</button></div>';
    if (!pids.length) {
      html += '<div class="add-menu-noproj">No projects yet.</div>';
    } else {
      pids.forEach(pid => {
        html += '<button class="add-menu-item" data-add-project="' + pid + '">' + esc(projects[pid].name) + '</button>';
      });
    }
    menu.innerHTML = html;
  }

  function addActiveChatToProject(pid) {
    if (activeChatId && conversations[activeChatId]) {
      conversations[activeChatId].projectId = pid;
      activeProjectId = pid;
    } else {
      newChat(pid);
    }
    save();
    renderSidebar();
    updateTopbar();
    closeAddMenus();
  }

  addMenus.forEach(function(pair) {
    pair.btn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleAddMenu(pair);
    });
    pair.menu.addEventListener('click', function(e) {
      e.stopPropagation();
      const addEl = e.target.closest('[data-add]');
      if (addEl) {
        const action = addEl.dataset.add;
        if (action === 'attach') {
          closeAddMenus();
          document.getElementById('chat-file-input').click();
        } else if (action === 'websearch') {
          webSearchEnabled = !webSearchEnabled;
          try { localStorage.setItem('gooey_websearch', webSearchEnabled ? '1' : '0'); } catch {}
          fillAddMenuRoot(pair.menu);
          positionAddMenu(pair);
        } else if (action === 'project') {
          fillAddMenuProjects(pair.menu);
          positionAddMenu(pair);
        } else if (action === 'root') {
          fillAddMenuRoot(pair.menu);
          positionAddMenu(pair);
        } else if (action === 'newchat') {
          closeAddMenus();
          newChat();
        }
        return;
      }
      const projEl = e.target.closest('[data-add-project]');
      if (projEl) addActiveChatToProject(projEl.dataset.addProject);
    });
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.add-menu-wrap')) closeAddMenus();
  });

  function clampNum(v, lo, hi, def) {
    const n = parseFloat(v);
    if (isNaN(n)) return def;
    return Math.min(hi, Math.max(lo, n));
  }
  function getParams() {
    const np = parseInt(document.getElementById('param-numpredict').value, 10);
    const p = {
      temperature: clampNum(document.getElementById('param-temp').value, 0, 2, 0.8),
      top_p: clampNum(document.getElementById('param-topp').value, 0, 1, 0.9),
      num_ctx: parseInt(document.getElementById('param-numctx').value, 10) || 2048
    };
    if (!isNaN(np)) p.num_predict = Math.round(Math.min(4096, Math.max(1, np)));
    return p;
  }
  function saveParams() {
    const p = [];
    ['param-temp', 'param-topp', 'param-numpredict', 'param-numctx'].forEach(function(id) { p.push(document.getElementById(id).value); });
    try { localStorage.setItem('gooey_params', JSON.stringify(p)); } catch {}
  }
  function loadParams() {
    try {
      const raw = localStorage.getItem('gooey_params');
      if (!raw) return;
      const p = JSON.parse(raw);
      ['param-temp', 'param-topp', 'param-numpredict', 'param-numctx'].forEach(function(id, i) {
        if (p[i] == null) return;
        const el = document.getElementById(id);
        if (el) { el.value = p[i]; document.getElementById(id + '-val').textContent = p[i]; }
      });
    } catch {}
  }
  document.getElementById('param-temp').addEventListener('input', function() { document.getElementById('param-temp-val').textContent = this.value; saveParams(); });
  document.getElementById('param-topp').addEventListener('input', function() { document.getElementById('param-topp-val').textContent = this.value; saveParams(); });
  document.getElementById('param-numpredict').addEventListener('input', function() { document.getElementById('param-numpredict-val').textContent = this.value; saveParams(); });
  document.getElementById('param-numctx').addEventListener('input', function() { document.getElementById('param-numctx-val').textContent = this.value; saveParams(); });
  document.getElementById('params-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    const pop = document.getElementById('params-popover');
    const wasOpen = pop.classList.contains('open');
    pop.classList.toggle('open');
    if (!wasOpen) {
      pop.style.top = '0px';
      pop.style.left = '0px';
      const rect = this.getBoundingClientRect();
      const estH = pop.scrollHeight;
      let top = rect.top - estH - 8;
      if (top < 8) top = rect.bottom + 8;
      if (top + estH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - estH - 8);
      pop.style.top = top + 'px';
      pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 270)) + 'px';
    }
  });
  document.addEventListener('click', function() { document.getElementById('params-popover').classList.remove('open'); });

  // --- Drag and drop ---
  const chatEl = document.getElementById('chat');
  const dragOverlay = document.getElementById('drag-overlay');
  let dragCounter = 0;
  chatEl.addEventListener('dragenter', function(e) { e.preventDefault(); dragCounter++; dragOverlay.classList.add('active'); });
  chatEl.addEventListener('dragleave', function(e) { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragOverlay.classList.remove('active'); dragCounter = 0; } });
  chatEl.addEventListener('dragover', function(e) { e.preventDefault(); });
  chatEl.addEventListener('drop', function(e) {
    e.preventDefault(); dragCounter = 0; dragOverlay.classList.remove('active');
    if (e.dataTransfer.files.length > 0) handleChatFileUpload(e.dataTransfer.files);
  });

  // --- Regenerate last response ---
  function regenerateLast() {
    if (isChatStreaming(activeChatId) || !activeChatId) return;
    const conv = conversations[activeChatId];
    // Find last user message, strip everything after it
    let lastUserIdx = -1;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const mm = conv.messages[i];
      if (mm.role === 'user' && !mm.injected) {
        lastUserIdx = i;
        conv.messages.length = i + 1;
        break;
      }
    }
    if (lastUserIdx < 0) return;
    const lastUser = conv.messages[lastUserIdx];
    if (!lastUser || lastUser.role !== 'user') return;
    const model = document.getElementById('model-select').value;
    if (!model) {
      showDialog({ title: 'No model', message: 'Select a model first.' });
      return;
    }
    const userText = lastUser.content.split('\n\n--- File:')[0];
    const userImages = lastUser.images && lastUser.images.length ? lastUser.images.slice() : [];
    conv.messages.pop();
    if (conv.messages.length === 0) {
      delete conversations[activeChatId];
      activeChatId = null;
      renderSidebar();
      renderChat();
      return;
    }
    save();
    renderChat();
    // Auto-resend
    document.getElementById('input').value = userText;
    autoResize(document.getElementById('input'));
    if (userImages.length) {
      chatAttachments = userImages.map(img => ({
        name: 'image',
        base64: typeof img === 'string' ? img : '',
        size: 0,
        isImage: true,
        mime: 'image/png'
      }));
      renderAttachBar();
    }
    send();
  }

  // --- Global conversation search ---
  function toggleSearch() {
    const panel = document.getElementById('search-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      document.getElementById('search-input').focus();
      document.getElementById('search-input').select();
    }
  }
  function closeSearch() {
    document.getElementById('search-panel').classList.remove('open');
    const si = document.getElementById('search-input');
    if (si) si.value = '';
    const sr = document.getElementById('search-results');
    if (sr) sr.innerHTML = '';
  }
  function doGlobalSearch() {
    const q = document.getElementById('search-input').value.trim().toLowerCase();
    const results = document.getElementById('search-results');
    results.innerHTML = '';
    if (!q) { results.innerHTML = ''; return; }
    const matches = [];
    Object.keys(conversations).forEach(cid => {
      const conv = conversations[cid];
      // Match title
      if (conv.title && conv.title.toLowerCase().includes(q)) {
        matches.push({ cid, title: conv.title, snippet: conv.title, projectId: conv.projectId });
        return;
      }
      // Match message content
      for (const m of (conv.messages || [])) {
        if (m.content && m.content.length <= 2000 && m.content.toLowerCase().includes(q)) {
          const plain = m.content.split('\n\n--- File:')[0].replace(/[#*`>\[\]]/g, '');
          const idx = plain.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 40);
          const end = Math.min(plain.length, idx + q.length + 60);
          const snippet = (start > 0 ? '...' : '') + plain.slice(start, end) + (end < plain.length ? '...' : '');
          matches.push({ cid, title: conv.title || 'Untitled', snippet, projectId: conv.projectId });
          break;
        }
      }
    });
    if (matches.length === 0) { results.innerHTML = '<div class="search-empty">No results found</div>'; return; }
    matches.slice(0, 50).forEach(m => {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.dataset.chat = m.cid;
      if (m.projectId) div.dataset.project = m.projectId;
      // Highlight match in snippet
      const snippetHtml = esc(m.snippet).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
      let projLabel = '';
      if (m.projectId && projects[m.projectId]) projLabel = `<div class="search-result-proj">${esc(projects[m.projectId].name)}</div>`;
      div.innerHTML = `<div class="search-result-title">${esc(m.title)}</div><div class="search-result-snippet">${snippetHtml}</div>${projLabel}`;
      results.appendChild(div);
    });
  }
  document.getElementById('files-toggle').addEventListener('click', toggleFilePanel);
  document.getElementById('search-toggle').addEventListener('click', function(e) {
    e.stopPropagation();
    toggleSearch();
  });
  document.getElementById('search-panel').addEventListener('click', function(e) { e.stopPropagation(); });
  document.addEventListener('click', function() { closeSearch(); });
  let searchDebounce = null;
  document.getElementById('search-input').addEventListener('input', function() { clearTimeout(searchDebounce); searchDebounce = setTimeout(doGlobalSearch, 150); });
  document.getElementById('search-results').addEventListener('click', function(e) {
    const result = e.target.closest('.search-result');
    if (!result) return;
    const cid = result.dataset.chat;
    if (result.dataset.project) activeProjectId = result.dataset.project;
    switchChat(cid);
    closeSearch();
  });

  // --- Export as markdown file ---
  function exportChatFile() {
    if (!activeChatId || !conversations[activeChatId]) return;
    const conv = conversations[activeChatId];
    let md = `# ${conv.title}\n\n`;
    conv.messages.forEach(m => {
      if (m.injected) return;
      if (m.role === 'user') {
        const text = m.content.split('\n\n--- File:')[0];
        md += `## You\n\n${text}\n\n`;
        if (m.images && m.images.length) md += `*(${m.images.length} image(s) attached)*\n\n`;
      } else {
        md += `## Assistant\n\n${m.content}${searchSources(m)}\n\n`;
      }
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (conv.title || 'chat').replace(/[^a-z0-9]/gi, '_') + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- Event delegation ---
  document.addEventListener('click', function(e) {
    const t = e.target;

    // Sidebar: chat item
    const sidebarItem = t.closest('.sidebar-item');
    if (sidebarItem && sidebarItem.dataset.chat && !t.dataset.action) {
      switchChat(sidebarItem.dataset.chat);
      return;
    }

    // Code copy
    if (t.dataset.action === 'copy-code') {
      const code = t.closest('.code-block').querySelector('code').textContent;
      navigator.clipboard.writeText(code);
      t.textContent = 'Copied!';
      setTimeout(() => t.textContent = 'Copy', 1500);
      return;
    }

    // Code toggle
    if (t.dataset.action === 'toggle-code') {
      const block = t.closest('.code-block');
      block.classList.toggle('collapsed');
      t.textContent = block.classList.contains('collapsed') ? `Show ${t.textContent.match(/\d+/)?.[0] || ''} lines` : 'Collapse';
      return;
    }

    // Regenerate
    if (t.dataset.action === 'regenerate') {
      e.stopPropagation();
      regenerateLast();
      return;
    }

    // Copy entire message
    if (t.dataset.action === 'copy-msg') {
      e.stopPropagation();
      const content = t.closest('.message-assistant')?.querySelector('.content')?.textContent || '';
      navigator.clipboard.writeText(content).then(() => {
        t.textContent = 'Copied!';
        t.classList.add('copied');
        setTimeout(() => { t.textContent = 'Copy'; t.classList.remove('copied'); }, 1500);
      });
      return;
    }

    // KB remove
    if (t.dataset.kb) {
      const proj = getViewingProject();
      if (proj && proj.kbFiles) {
        delete proj.kbFiles[t.dataset.kb];
        commitProjectField();
        renderKbFiles();
      }
      return;
    }

    // Attach remove
    if (t.dataset.attach !== undefined) {
      chatAttachments.splice(Number(t.dataset.attach), 1);
      renderAttachBar();
      return;
    }
  });

  // --- Input events ---
  document.getElementById('input').addEventListener('input', function() { autoResize(this); });
  document.getElementById('input').addEventListener('keydown', handleKey);
  document.getElementById('send-btn').addEventListener('click', handleSendOrStop);
  document.getElementById('new-chat-btn').addEventListener('click', () => newChat());
  document.getElementById('project-settings-btn').addEventListener('click', openProjectSettings);
  document.getElementById('export-btn').addEventListener('click', exportChat);
  document.getElementById('export-file-btn').addEventListener('click', exportChatFile);
  document.getElementById('chat-file-input').addEventListener('change', function(e) { handleChatFileUpload(e.target.files); e.target.value = ''; });
  document.getElementById('kb-upload-btn').addEventListener('click', () => document.getElementById('kb-file-input').click());
  document.getElementById('kb-file-input').addEventListener('change', function(e) { handleKbUpload(e.target.files); e.target.value = ''; });
  document.getElementById('detail-title').addEventListener('input', function() {
    const proj = getViewingProject();
    if (!proj) return;
    proj.name = this.value.trim() || 'New project';
    commitProjectField();
  });
  document.getElementById('detail-instructions').addEventListener('input', function() {
    const proj = getViewingProject();
    if (!proj) return;
    proj.instructions = this.value;
    commitProjectField();
  });
  document.getElementById('clear-everything-btn').addEventListener('click', clearEverything);

  // --- Chat ⠸ menu + rename modal events ---
  document.addEventListener('click', function(e) {
    const dots = e.target.closest('.chat-dots-btn');
    if (dots) {
      e.stopPropagation();
      const item = dots.closest('.sidebar-item');
      if (item && item.dataset.chat) { openChatMenu(item.dataset.chat, dots); return; }
      const dchat = dots.closest('[data-detail-chat]');
      if (dchat) { openChatMenu(dchat.getAttribute('data-detail-chat'), dots); return; }
      const card = dots.closest('.project-card');
      if (card) { openProjectMenu(card.getAttribute('data-project'), dots); return; }
      return;
    }
    if (e.target.closest('#chat-menu')) {
      e.stopPropagation();
      const btn = e.target.closest('.chat-menu-item');
      if (!btn) return;
      const cid = btn.dataset.cid;
      const pid = btn.dataset.pid;
      const action = btn.dataset.action;
      closeChatMenu();
      if (action === 'rename-chat') promptRenameChat(cid);
      else if (action === 'move-chat') moveChatToProject(cid, pid);
      else if (action === 'delete-chat-menu') deleteChat(cid);
      else if (action === 'project-new-chat') { newChat(pid); showPage('chat'); }
      else if (action === 'project-edit') editProjectById(pid);
      else if (action === 'project-delete') deleteProject(pid);
      return;
    }
    closeChatMenu();
  });
  document.getElementById('rename-save-btn').addEventListener('click', applyRenameChat);
  document.getElementById('rename-cancel-btn').addEventListener('click', closeRenameModal);
  document.getElementById('rename-close-btn').addEventListener('click', closeRenameModal);
  document.getElementById('rename-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') applyRenameChat();
    else if (e.key === 'Escape') closeRenameModal();
  });
  document.getElementById('dialog-ok-btn').addEventListener('click', function() {
    const cb = dialogCallback;
    closeDialog();
    if (cb) cb();
  });
  document.getElementById('dialog-cancel-btn').addEventListener('click', function() {
    const cb = dialogCancelCallback;
    closeDialog();
    if (cb) cb();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && dialogOpen) {
      const cb = dialogCancelCallback;
      closeDialog();
      if (cb) cb();
    }
  });
  document.getElementById('dialog-modal').addEventListener('click', function(e) {
    if (e.target === this && dialogOpen) {
      const cb = dialogCancelCallback;
      closeDialog();
      if (cb) cb();
    }
  });

  // Mobile sidebar toggle
  document.getElementById('sidebar-toggle').addEventListener('click', function() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('open');
  });
  document.getElementById('sidebar-overlay').addEventListener('click', function() {
    document.getElementById('sidebar').classList.remove('open');
    this.classList.remove('open');
  });

  // Keep the browser UI (address bar / status bar) in sync with the active theme
  function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme:dark)').matches);
    meta.setAttribute('content', dark ? '#1a1a1a' : '#faf8f5');
  }

  // Theme
  const savedTheme = localStorage.getItem('gooey_theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  document.getElementById('theme-toggle').addEventListener('click', function() {
    const current = document.documentElement.getAttribute('data-theme');
    let next;
    if (current === 'dark') next = 'light';
    else if (current === 'light') next = '';
    else {
      // No explicit theme — following system. If system is dark, first tap should visibly switch to light.
      const sysDark = matchMedia('(prefers-color-scheme:dark)').matches;
      next = sysDark ? 'light' : 'dark';
    }
    if (next) { document.documentElement.setAttribute('data-theme', next); localStorage.setItem('gooey_theme', next); }
    else { document.documentElement.removeAttribute('data-theme'); localStorage.removeItem('gooey_theme'); }
    this.innerHTML = (next === 'dark' || (!next && matchMedia('(prefers-color-scheme:dark)').matches)) ? '&#9788;' : '&#9789;';
    syncThemeColor();
  });
  // Set initial icon + theme color
  (function() { const t = document.getElementById('theme-toggle'); const d = document.documentElement.getAttribute('data-theme'); t.innerHTML = (d === 'dark' || (!d && matchMedia('(prefers-color-scheme:dark)').matches)) ? '&#9788;' : '&#9789;'; syncThemeColor(); })();

  // --- File panel (read-only sandbox browser) ---
  let fileTree = {};
  let activeFilePath = null;
  const RUNNABLE_EXTS = new Set(['py','sh','js','ts','rb','pl','php']);

  function toggleFilePanel() {
    const panel = document.getElementById('file-panel');
    const overlay = document.getElementById('file-overlay');
    panel.classList.toggle('open');
    overlay.classList.toggle('open');
    if (panel.classList.contains('open')) refreshFileTree();
  }

  async function refreshFileTree() {
    if (!activeChatId) return;
    const cid = activeChatId;
    const token = ++fileTreeToken;
    try {
      const res = await fetch('/api/files?tree=&chatId=' + encodeURIComponent(cid));
      const data = await res.json();
      if (token !== fileTreeToken || activeChatId !== cid) return;
      fileTree = data.tree || [];
      renderFileTree();
    } catch {}
  }

  function renderFileTree() {
    const el = document.getElementById('file-tree');
    el.innerHTML = '';
    function renderNode(items, container, depth) {
      items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'file-tree-item' + (item.path === activeFilePath ? ' active' : '');
        div.style.paddingLeft = (8 + depth * 14) + 'px';
        const icon = item.isDir ? '&#128193;' : getFileIcon(item.name);
        div.innerHTML = `<span class="icon">${icon}</span><span class="name">${esc(item.name)}</span>`;
        div.addEventListener('click', () => {
          if (item.isDir) {
            const children = div.nextElementSibling;
            if (children && children.classList.contains('file-tree-children')) {
              children.style.display = children.style.display === 'none' ? '' : 'none';
            }
          } else {
            previewFile(item.path);
          }
        });
        container.appendChild(div);
        if (item.isDir && item.children) {
          const childContainer = document.createElement('div');
          childContainer.className = 'file-tree-children';
          renderNode(item.children, childContainer, depth + 1);
          container.appendChild(childContainer);
        }
      });
    }
    renderNode(fileTree, el, 0);
  }

  function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = { md: '&#128221;', json: '&#128196;', py: '&#128013;', js: '&#9997;', ts: '&#128309;', html: '&#127760;', css: '&#127912;', txt: '&#128196;', yaml: '&#128220;', yml: '&#128220;', sh: '&#9881;', csv: '&#128202;', xml: '&#128196;', rs: '&#128013;', go: '&#128013;', java: '&#9749;', c: '&#128196;', cpp: '&#128196;', xls: '&#128202;', xlsx: '&#128202;', ods: '&#128202;' };
    return icons[ext] || '&#128196;';
  }

  function isRunnable(path) {
    const ext = path.split('.').pop().toLowerCase();
    return RUNNABLE_EXTS.has(ext);
  }

  function isSpreadsheet(path) {
    const ext = path.split('.').pop().toLowerCase();
    return ['csv', 'tsv', 'xlsx', 'xls', 'ods'].includes(ext);
  }

  function parseCSV(text, delimiter) {
    if (!delimiter) delimiter = text.includes('\t') ? '\t' : ',';
    const rows = [];
    let row = [];
    let cell = '';
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i+1] === '"') { cell += '"'; i++; }
          else inQuote = false;
        } else { cell += ch; }
      } else {
        if (ch === '"') { inQuote = true; }
        else if (ch === delimiter) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i+1] === '\n') i++;
          row.push(cell); cell = '';
          rows.push(row); row = [];
        } else { cell += ch; }
      }
    }
    row.push(cell);
    if (row.some(c => c)) rows.push(row);
    return rows;
  }

  function renderCSVTable(text) {
    const rows = parseCSV(text);
    if (rows.length === 0) return '<p style="color:var(--text-secondary)">Empty CSV</p>';
    const headers = rows[0].slice(0, 200);
    const dataRows = rows.slice(1, 1001);
    const truncated = dataRows.length < rows.length - 1;
    let html = '<table class="csv-table"><thead><tr>';
    headers.forEach(h => { html += `<th>${esc(h)}</th>`; });
    html += '</tr></thead><tbody>';
    dataRows.forEach(row => {
      html += '<tr>';
      headers.forEach((_, i) => { html += `<td>${esc(row[i] || '')}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (truncated) html += '<p style="color:var(--text-secondary)">…showing first 1000 rows</p>';
    return html;
  }

  function sheetCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function renderJSONTable(val) {
    let rows;
    if (Array.isArray(val)) {
      if (val.length && val.every(x => x !== null && typeof x === 'object' && !Array.isArray(x))) {
        const keys = [...new Set(val.flatMap(x => Object.keys(x)))];
        rows = [keys, ...val.map(x => keys.map(k => sheetCell(x[k])))];
      } else {
        rows = val.map(x => [sheetCell(x)]);
      }
    } else if (val !== null && typeof val === 'object') {
      const entries = Object.entries(val);
      const subKeys = [...new Set(entries.flatMap(([, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v) : []))];
      if (subKeys.length) {
        rows = [['Letter', ...subKeys], ...entries.map(([k, v]) => [k, ...subKeys.map(sk => sheetCell(v ? v[sk] : null))])];
      } else {
        rows = [['Key', 'Value'], ...entries.map(([k, v]) => [k, sheetCell(v)])];
      }
    } else {
      rows = [[sheetCell(val)]];
    }
    if (!rows.length) return '<p style="color:var(--text-secondary)">Empty table</p>';
    const MAX_ROWS = 201;
    const MAX_COLS = 50;
    const rowCap = Math.min(rows.length, MAX_ROWS);
    const showCols = Math.min(Math.max.apply(null, rows.slice(0, rowCap).map(r => r.length)), MAX_COLS);
    let html = '<table class="csv-table"><thead><tr>';
    for (let i = 0; i < showCols; i++) {
      html += `<th>${esc(i < MAX_COLS - 1 ? (rows[0][i] === undefined ? '' : rows[0][i]) : '...')}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rowCap; r++) {
      const row = rows[r];
      html += '<tr>';
      for (let i = 0; i < showCols; i++) {
        html += `<td>${esc(i < MAX_COLS - 1 ? (row[i] === undefined ? '' : row[i]) : '...')}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    if (rows.length > rowCap) html += '<p style="color:var(--text-secondary);font-size:12px">' + (rows.length - rowCap) + ' more rows...</p>';
    return html;
  }

  function renderSheetTable(text) {
    let jsonVal = null;
    try { jsonVal = JSON.parse(text); } catch {}
    if (jsonVal !== null && typeof jsonVal === 'object') return renderJSONTable(jsonVal);
    return renderCSVTable(text);
  }

  let lastRunPath = null;
  let fileTreeToken = 0;
  let previewToken = 0;
  let compactionAbort = null;
  document.getElementById('run-rerun-btn').addEventListener('click', () => { if (lastRunPath) runFile(lastRunPath); });
  document.getElementById('run-close').addEventListener('click', () => document.getElementById('run-output').classList.remove('open'));
  document.getElementById('run-stdin').addEventListener('keydown', (e) => { if (e.key === 'Enter' && lastRunPath) runFile(lastRunPath); });

  async function previewFile(path) {
    activeFilePath = path;
    const cid = activeChatId;
    const token = ++previewToken;
    renderFileTree();
    const content = document.getElementById('file-editor-content');
    const runOutput = document.getElementById('run-output');
    runOutput.classList.remove('open');
    lastRunPath = null;

    // Remove any existing preview bar
    const existingBar = content.parentNode.querySelector('.file-preview-bar');
    if (existingBar) existingBar.remove();

    // Add preview bar with path + run + download buttons
    const bar = document.createElement('div');
    bar.className = 'file-preview-bar';
    const runBtn = isRunnable(path) ? `<button class="run-btn" id="run-file-btn">&#9654; Run</button>` : '';
    bar.innerHTML = `<span class="file-path">${esc(path)}</span>${runBtn}<button class="run-btn" id="download-file-btn" style="background:#6366f1" title="Download">&#8615; Save</button>`;
    content.parentNode.insertBefore(bar, content);
    document.getElementById('download-file-btn').addEventListener('click', () => downloadFile(path));

    if (isRunnable(path)) {
      lastRunPath = path;
      document.getElementById('run-file-btn').addEventListener('click', () => runFile(path));
    }

    try {
      const res = await fetch('/api/files/' + encodeURIComponent(path) + '?chatId=' + encodeURIComponent(activeChatId));
      const data = await res.json();
      if (token !== previewToken || activeChatId !== cid) return;
      if (data.error) { content.innerHTML = `<div class="file-empty-state">${esc(data.error)}</div>`; return; }
      if (data.binary) {
        const m = String(data.mime || '');
        if (/^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/.test(m)) {
          const safeMime = (/^[\w.+-]+\/[\w.+-]+$/.test(m) ? m : 'image/png');
          content.innerHTML = `<div class="preview" style="text-align:center;padding:24px"><img src="data:${esc(safeMime)};base64,${b64OrEmpty(data.content)}" style="max-width:100%;border-radius:8px"></div>`;
        } else {
          content.innerHTML = `<div class="binary-preview"><p>${esc(data.mime || '')}</p><p>${formatSize(data.size || 0)}</p></div>`;
        }
        return;
      }
      const ext = path.split('.').pop().toLowerCase();
      if (ext === 'md' || ext === 'markdown') {
        content.innerHTML = `<div class="preview">${renderMd(data.content)}</div>`;
      } else if (isSpreadsheet(path)) {
        content.innerHTML = `<div class="csv-table-wrap">${renderSheetTable(data.content)}</div>`;
      } else if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
        const m2 = String(data.mime || '');
        if (/^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/.test(m2)) {
          const safeMime2 = (/^[\w.+-]+\/[\w.+-]+$/.test(m2) ? m2 : 'image/png');
          content.innerHTML = `<div class="preview" style="text-align:center"><img src="data:${esc(safeMime2)};base64,${b64OrEmpty(data.content)}" style="max-width:100%;border-radius:8px"></div>`;
        } else {
          content.innerHTML = `<div class="binary-preview"><p>${esc(data.mime || '')}</p><p>${formatSize(data.size || 0)}</p></div>`;
        }
      } else {
        const fileContent = String(data.content || '');
        let highlighted;
        if (fileContent.length > 4000) {
          highlighted = esc(fileContent);
        } else if (hljs.getLanguage(ext)) {
          highlighted = hljs.highlight(fileContent, { language: ext }).value;
        } else if (fileContent.length < 1000) {
          highlighted = hljs.highlightAuto(fileContent).value;
        } else {
          highlighted = esc(fileContent);
        }
        content.innerHTML = `<div class="preview" style="padding:0"><pre style="margin:0;padding:16px;background:var(--code-bg);overflow:auto;height:100%"><code class="hljs">${highlighted}</code></pre></div>`;
      }
    } catch { content.innerHTML = '<div class="file-empty-state">Failed to load</div>'; }
  }

  async function downloadFile(path) {
    try {
      const res = await fetch('/api/files/' + encodeURIComponent(path) + '?chatId=' + encodeURIComponent(activeChatId));
      const data = await res.json();
      if (data.error) { showDialog({ title: 'Download failed', message: data.error }); return; }
      let blob;
      if (data.binary) {
        const bin = atob(data.content);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const safeMime = (/^[\w.+-]+\/[\w.+-]+$/.test(String(data.mime || '')) ? data.mime : 'application/octet-stream');
        blob = new Blob([arr], { type: safeMime });
      } else {
        const safeMime = (/^[\w.+-]+\/[\w.+-]+$/.test(String(data.mime || '')) ? data.mime : 'text/plain');
        blob = new Blob([data.content], { type: safeMime });
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = path.split('/').pop();
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {}
  }

  async function runFile(path) {
    const runOutput = document.getElementById('run-output');
    const stdoutEl = document.getElementById('run-stdout');
    const stderrEl = document.getElementById('run-stderr');
    const exitEl = document.getElementById('run-exit-code');
    const timeEl = document.getElementById('run-time');
    const stdinVal = document.getElementById('run-stdin').value;
    const runBtn = document.getElementById('run-file-btn');

    if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Running...'; }
    runOutput.classList.add('open');
    stdoutEl.textContent = '';
    stderrEl.textContent = '';
    exitEl.textContent = '';
    exitEl.className = 'exit-code';
    timeEl.textContent = '';

    const t0 = Date.now();
    try {
      const res = await fetch('/api/files/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChatId, path, stdin: stdinVal })
      });
      const data = await res.json();
      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
      timeEl.textContent = `${elapsed}s`;
      if (data.error) {
        exitEl.textContent = 'Error';
        exitEl.className = 'exit-code failure';
        stderrEl.textContent = data.error;
      } else {
        exitEl.textContent = `Exit ${data.exit_code}`;
        exitEl.className = 'exit-code ' + (data.exit_code === 0 ? 'success' : 'failure');
        if (data.stdout) stdoutEl.textContent = data.stdout;
        if (data.stderr) stderrEl.textContent = data.stderr;
        if (!data.stdout && !data.stderr) stdoutEl.textContent = '(no output)';
      }
    } catch (e) {
      exitEl.textContent = 'Error';
      exitEl.className = 'exit-code failure';
      stderrEl.textContent = e.message;
    }
    if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '&#9654; Run'; }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  document.getElementById('file-overlay').addEventListener('click', toggleFilePanel);
  document.getElementById('file-refresh').addEventListener('click', refreshFileTree);

  // --- Web search + paused file-ops (pause/resume flows) ---
  let webSearchEnabled = false;

  function withTimeout(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, cancel: function() { clearTimeout(t); } };
  }

  function stripFencedRegions(content) {
    return String(content || '').replace(/```[\s\S]*?(?:```|$)/g, '###');
  }

  // --- Web search (pause/resume flow) ---
  function detectCompleteSearchTags(content) {
    content = stripFencedRegions(content);
    const tags = [];
    const re = /<search>([\s\S]*?)<\/search>/gi;
    let m;
    while ((m = re.exec(content)) !== null) tags.push(m[1].replace(/<[^>]+>/g, '').trim());
    return tags;
  }

  function buildSearchCardEl(entry, searchIdx) {
    const card = document.createElement('div');
    card.className = 'search-card' + (entry.collapsed !== false ? ' collapsed' : '');
    if (searchIdx != null) card.dataset.searchIdx = String(searchIdx);
    const bodyHtml = (!entry.err && entry.status === 'done')
      ? (entry.results.length
          ? entry.results.map(r => '<div class="search-result"><a href="' + esc(safeUrl(r.url)) + '" target="_blank" rel="noopener">' + esc(r.title) + '</a>' + (r.url ? '<div class="search-result-url">' + esc(safeUrl(r.url)) + '</div>' : '') + (r.snippet ? '<div class="search-result-snippet">' + esc(r.snippet) + '</div>' : '') + '</div>').join('')
          : '<div class="search-result-none">No results found.</div>')
      : '';
    const status = entry.err
      ? 'Search failed'
      : entry.status === 'loading'
        ? '<span class="search-spinner"></span> Searching the web...'
        : entry.results.length + (entry.results.length === 1 ? ' result' : ' results') + ' - click to view';
    card.innerHTML = `
      <div class="search-card-head">
        <span>&#128269;</span>
        <span class="search-query">${esc(entry.query)}</span>
        <span class="search-status${entry.err ? ' error' : ''}">${status}</span>
        <span class="search-caret">&#9660;</span>
      </div>
      <div class="search-card-body">${bodyHtml}</div>`;
    return card;
  }

  async function runSearchAndResume(queries, lastRow, chatId, token) {
    const conv = chatId ? conversations[chatId] : (activeChatId ? conversations[activeChatId] : null);
    const msg = conv && conv.messages.length ? conv.messages[conv.messages.length - 1] : null;
    const qarr = Array.isArray(queries) ? queries : [queries];
    const blocks = [];
    for (let qi = 0; qi < qarr.length; qi++) {
      const query = String(qarr[qi] || '').trim() || 'search';
      const liveIdx = msg && msg.searchCards ? msg.searchCards.length : 0;
      const entry = { query, status: 'loading', results: [], err: null, collapsed: true };
      entry._liveIdx = liveIdx;
      let card = null;
      if (lastRow) { card = buildSearchCardEl(entry, liveIdx); lastRow.appendChild(card); }
      if (msg && msg.role === 'assistant') {
        msg.searchCards = msg.searchCards || [];
        msg.searchCards.push(entry);
      }
      let results = [];
      let err = null;
      const to = withTimeout(30000);
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(query), { signal: to.signal });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
        results = data.results || [];
      } catch (e) {
        err = (e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /timed out/i.test(e.message || ''))) ? 'Search timed out.' : (e.message || 'Search failed.');
      } finally {
        to.cancel();
      }
      entry.status = 'done';
      entry.results = results;
      entry.err = err;
      if (lastRow && lastRow.isConnected) {
        const fresh = buildSearchCardEl(entry, entry._liveIdx);
        if (card && card.isConnected) card.replaceWith(fresh);
      }
      save();
      blocks.push({ query, results, err });
    }
    if (isChatStreaming(chatId) || token !== resumeToken(chatId)) return;
    if (!chatId || !conversations[chatId]) return;
    if (!msg || conversations[chatId].messages[conversations[chatId].messages.length - 1] !== msg) return;
    const formatted = blocks.map((b, i) => {
      const head = (i + 1) + '. ' + b.query;
      if (b.err) return head + '\n   (search failed: ' + b.err + ')';
      if (!b.results.length) return head + '\n   No results found.';
      return head + '\n' + b.results.map(r => '   - ' + r.title + '\n     ' + r.url + '\n     ' + (r.snippet || '')).join('\n');
    }).join('\n');
    send('Web search results:\n' + formatted + '\n\nAnswer using the results and cite sources with their URLs. Continue.', { injected: true, chatId });
  }

  // --- Extra info file (read/search, silent pause/resume) ---
  function detectCompleteInfoTags(content) {
    content = stripFencedRegions(content);
    const tags = [];
    const readRe = /<read_info>([\s\S]*?)<\/read_info>/gi;
    const searchRe = /<search_info>([\s\S]*?)<\/search_info>/gi;
    let m;
    while ((m = readRe.exec(content)) !== null) tags.push({ kind: 'read', query: m[1].replace(/<[^>]+>/g, '').trim() });
    while ((m = searchRe.exec(content)) !== null) tags.push({ kind: 'search', query: m[1].replace(/<[^>]+>/g, '').trim() });
    return tags;
  }

  function stripInfoTags(content) {
    return content
      .replace(/<search_info>[\s\S]*?<\/search_info>/gi, '')
      .replace(/<read_info>[\s\S]*?<\/read_info>/gi, '')
      .replace(/<\/?(?:search_info|read_info)[^>]*>/gi, '')
      .replace(/<\/?(?:search_info|read_info)>/gi, '')
      .trim();
  }

  function detectCompleteChatSearchTags(content) {
    content = stripFencedRegions(content);
    const tags = [];
    const re = /<search_chats>([\s\S]*?)<\/search_chats>/gi;
    let m;
    while ((m = re.exec(content)) !== null) tags.push(m[1].replace(/<[^>]+>/g, '').trim());
    return tags;
  }

  function stripChatSearchTags(content) {
    return content
      .replace(/<search_chats>[\s\S]*?<\/search_chats>/gi, '')
      .replace(/<\/?search_chats[^>]*>/gi, '');
  }

  function firstToolFragmentIndex(content) {
    const m = content.search(/<(?:search_info|read_info|search_chats|search|create_file|edit_file|append_file|read_file|delete_file|create_dir)\b[^>\n]{0,120}$/i);
    return m === -1 ? -1 : m;
  }

  function detectUnclosedToolTags(content) {
    content = stripFencedRegions(content);
    const out = [];
    let m;
    const pushIfPartial = (re, kind, tagName) => {
      if ((m = re.exec(content))) {
        const openerIdx = m.index;
        if (content.indexOf('</' + tagName, openerIdx) === -1) {
          if (content.slice(m.index + m[0].length).trim() !== '') return;
          out.push({ kind, query: (m[1] != null ? m[1] : '').trim() });
        }
      }
    };
    pushIfPartial(/<read_info>\s*([0-9a-fA-F]{1,16})/i, 'read', 'read_info');
    pushIfPartial(/<search_info>\s*([^\n<>]{0,80})/i, 'search', 'search_info');
    pushIfPartial(/<search_chats>\s*([^\n<>]{0,80})/i, 'chat', 'search_chats');
    pushIfPartial(/<search>\s*([^\n<>]{0,80})/i, 'search', 'search');
    return out;
  }

  function stripToolTags(content) {
    let c = stripChatSearchTags(stripInfoTags(content))
      .replace(/<search>[\s\S]*?<\/search>/gi, '')
      .replace(/<\/?search[^>]*>/gi, '')
      .trim();
    const frag = firstToolFragmentIndex(c);
    if (frag !== -1) c = c.slice(0, frag).trim();
    c = stripToolTagDebris(c).trim();
    return collapseOrphanFences(c);
  }

  async function runInfoAndResume(tag, lastRow, chatId, token) {
    const conv = chatId ? conversations[chatId] : (activeChatId ? conversations[activeChatId] : null);
    const msg = conv && conv.messages.length ? conv.messages[conv.messages.length - 1] : null;
    const qv = String(tag.query || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
    const isEntryRead = tag.kind === 'read' && /^[0-9a-fA-F]{8}$/.test(qv);
    let data = null;
    let err = null;
    try {
      let url;
      if (tag.kind === 'read') url = isEntryRead ? '/api/info?entry=' + encodeURIComponent(qv) : '/api/info';
      else if (tag.kind === 'search' && !qv) url = '/api/info';
      else url = '/api/info?q=' + encodeURIComponent(qv);
      const to = withTimeout(30000);
      try {
        const res = await fetch(url, { signal: to.signal });
        data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
      } finally {
        to.cancel();
      }
    } catch (e) { err = (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'Info file read timed out.' : (e.message || 'Failed to read the info file.'); }
    save();
    if (isChatStreaming(chatId) || token !== resumeToken(chatId)) return;
    if (!chatId || !conversations[chatId]) return;
    let injected;
    if (err) {
      injected = 'Info file error: ' + err + '\n\nContinue.';
    } else if (isEntryRead) {
      injected = 'Info file entry ' + qv + ':\n\n' + (data.heading ? '[' + data.heading + ']\n' : '') + data.content + '\n\nAnswer using this knowledge. Continue.';
    } else if (tag.kind === 'read') {
      injected = 'Info file contents (extra-info.md):\n\n' + data.content + '\n\nAnswer using this knowledge. Continue.';
    } else {
      const results = data.results || [];
      injected = results.length
        ? 'Info file search for "' + qv + '":\n' + results.map(r => 'Entry ' + r.entry + ': [' + r.heading + ']\n' + r.snippet).join('\n') + '\n\nTo read any matching entry in full, emit <read_info>ENTRY_CODE</read_info> copying the Entry Code exactly from the list above. Answer using this knowledge and continue.'
        : 'Info file search for "' + qv + '" found nothing. If helpful, say so briefly, then continue normally.';
    }
    if (isChatStreaming(chatId) || token !== resumeToken(chatId)) return;
    if (!chatId || !conversations[chatId]) return;
    if (!msg || conversations[chatId].messages[conversations[chatId].messages.length - 1] !== msg) return;
    if (lastRow && lastRow.isConnected) {
      const note = document.createElement('div');
      note.className = 'info-read-note';
      note.textContent = isEntryRead ? 'Read info entry ' + qv : tag.kind === 'read' ? 'Read info file' : 'Searched info file: ' + qv;
      lastRow.appendChild(note);
    }
    send(injected, { injected: true, chatId });
  }

  // --- Search other chats (permission: same project = silent, outside = ask) ---
  function findChatMatchesForTool(q, excludeCid) {
    const query = q.toLowerCase();
    const out = [];
    Object.keys(conversations).forEach(cid => {
      if (cid === excludeCid) return;
      const conv = conversations[cid];
      const msgs = conv.messages || [];
      let snippet = null;
      const titleHit = conv.title && conv.title.toLowerCase().includes(query);
      if (msgs.length) {
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.injected) continue;
          if (m.role === 'assistant' && i > 0 && msgs[i - 1] && msgs[i - 1].injected) continue;
          if (m.content && m.content.toLowerCase().includes(query)) {
            const plain = m.content.replace(/[#*`>\[\]]/g, '');
            const idx = plain.toLowerCase().indexOf(query);
            const start = Math.max(0, idx - 40);
            const end = Math.min(plain.length, idx + query.length + 60);
            snippet = (start > 0 ? '...' : '') + plain.slice(start, end) + (end < plain.length ? '...' : '');
            break;
          }
        }
        if (!snippet && titleHit) snippet = conv.title;
      }
      if (snippet) {
        out.push({ cid, title: conv.title || 'Untitled', snippet, projectId: conv.projectId || null, projectName: conv.projectId && projects[conv.projectId] ? projects[conv.projectId].name : '' });
      }
    });
    return out.slice(0, 50);
  }

  function formatChatSearchForInject(q, matches, targetChatId, scoped) {
    if (!matches.length) return 'Chat search for "' + q + '" found nothing. If helpful, say so briefly, then continue normally.';
    const scopeNote = scoped ? '\n(Only chats in the current project were searched.)' : '';
    const lines = matches.slice(0, 8).map((m, i) => (i + 1) + '. [' + m.title + '] ' + (m.cid === targetChatId ? '(current) ' : '') + (m.projectName ? '(' + m.projectName + ') ' : '') + '\n   ' + m.snippet);
    return 'Chat search for "' + q + '" found these conversations:' + scopeNote + '\n\n' + lines.join('\n') + '\n\nAnswer using this knowledge. Continue.';
  }

  function addToolNote(row, text) {
    if (!row || !row.isConnected) return;
    const note = document.createElement('div');
    note.className = 'info-read-note';
    note.textContent = text;
    row.appendChild(note);
  }

  function detectPersonalQuery(t) {
    const qw = /\b(?:what|which|tell|is|are|how|do you)\b/i;
    const rules = [
      { re: /\b(my|our|your user(?:'s)?)\s+(name|nickname)\b|\bwho am i\b/i, q: 'name' },
      { re: /\b(my|our|your user(?:'s)?)\s+age\b|\bhow old am i\b/i, q: 'age' },
      { re: /\b(my|our|your user(?:'s)?)\s+(age|birthday|device|phone|setup|computer|hardware)\b/i, q: 'device', ctx: true },
      { re: /\b(my|our|your user(?:'s)?)\s+projects?\b|\bwhat am i (working on|building)\b/i, q: 'projects' },
      { re: /\b(my|our|your user(?:'s)?)\s+(preferences?|likes?|dislikes?|history|background)\b/i, q: 'preferences', ctx: true }
    ];
    for (const r of rules) {
      if (!r.re.test(t)) continue;
      if (r.ctx && !qw.test(t) && t.length >= 60) continue;
      return r.q;
    }
    return null;
  }

  async function fetchInfoForInject(q, signal) {
    const to = withTimeout(30000);
    try {
      const r = await fetch('/api/info?q=' + encodeURIComponent(q), { signal: signal || to.signal });
      if (!r.ok) return null;
      const d = await r.json();
      const res = d.results || [];
      if (!res.length) return null;
      return 'Stored facts about the CURRENT USER (from extra-info.md). The person you are talking to right now IS this person — these facts (e.g. "Akiva", age 12) describe the user who is messaging you, NOT a third party. The user is allowed to know and discuss all of it; answer directly from it, never withhold it, and never refer to "the user" as someone other than the person chatting with you. The full answer is already here — reply immediately and do NOT emit any XML tags (no <search_info>, <read_info>, or others); just answer the question:\n\n' +
        res.slice(0, 4).map(it => 'Entry ' + it.entry + ': [' + it.heading + ']\n' + it.snippet).join('\n\n');
    } finally {
      to.cancel();
    }
  }

  async function runChatSearchAndResume(query, lastRow, chatId, token) {
    save();
    if (isChatStreaming(chatId) || token !== resumeToken(chatId)) return;
    if (!chatId || !conversations[chatId]) return;
    const conv = conversations[chatId];
    const pausedMsg = conv.messages[conv.messages.length - 1];
    if (!pausedMsg) return;
    const matches = findChatMatchesForTool(query, chatId);
    const curProject = conv.projectId || null;
    const external = matches.filter(m => m.projectId !== curProject);
    const freshCheck = function() {
      return !isChatStreaming(chatId) && token === resumeToken(chatId) && conversations[chatId] && conversations[chatId].messages[conversations[chatId].messages.length - 1] === pausedMsg;
    };
    if (external.length === 0) {
      if (freshCheck()) {
        if (lastRow && lastRow.isConnected && activeChatId === chatId) addToolNote(lastRow, 'Searched chats');
        send(formatChatSearchForInject(query, matches, chatId), { injected: true, chatId });
      }
      return;
    }
    const externalNames = external.slice(0, 3).map(m => '"' + m.title + '"').join(', ') + (external.length > 3 ? '…' : '');
    if (lastRow && lastRow.isConnected && activeChatId === chatId) addToolNote(lastRow, 'Asking you before searching ' + external.length + ' chat(s) outside this project');
    showDialog({
      title: 'Search other chats?',
      message: external.length + ' matching chat(s) belong to other projects (' + externalNames + '). Allow searching them for "' + query + '"?',
      confirmLabel: 'Allow',
      onConfirm: function() {
        if (!freshCheck()) return;
        const matchesNow = findChatMatchesForTool(query, chatId);
        if (matchesNow.length) {
          if (lastRow && lastRow.isConnected && activeChatId === chatId) addToolNote(lastRow, 'Searched chats (approved)');
          send(formatChatSearchForInject(query, matchesNow, chatId), { injected: true, chatId });
        } else {
          if (lastRow && lastRow.isConnected && activeChatId === chatId) addToolNote(lastRow, 'Searched chats');
          send(formatChatSearchForInject(query, [], chatId), { injected: true, chatId });
        }
      },
      onCancel: function() {
        if (!freshCheck()) return;
        const curConv = conversations[chatId];
        if (!curConv) return;
        const matchesNow = findChatMatchesForTool(query, chatId);
        const curProjNow = curConv.projectId || null;
        if (lastRow && lastRow.isConnected && activeChatId === chatId) addToolNote(lastRow, 'Search declined — not searching outside this project');
        const onlyInternal = matchesNow.filter(m => m.projectId === curProjNow);
        if (onlyInternal.length) send(formatChatSearchForInject(query, onlyInternal, chatId, true), { injected: true, chatId });
        else send('The user declined searching chats outside this project. Answer from what you know, or search chats within this project if useful. Continue.', { injected: true, chatId });
      }
    });
  }

  function detectCompleteFileOps(content) {
    return extractFileOps(content);
  }

  function stripFileOpsFromContent(content) {
    return cleanToolLeftovers(content);
  }

  function persistAbortedFileOps(msg) {
    const raw = msg.content || '';
    const ops = extractFileOps(raw);
    const cleaned = cleanToolLeftovers(raw);
    if (ops.length) {
      msg.fileOps = ops.map(o => ({ type: o.type, path: o.path, content: o.content, old: o.old, new: o.new, preview: (o.content || '').slice(0, 300), status: 'pending' }));
      msg.resumePending = true;
    }
    msg.content = cleaned;
    return ops;
  }

  function maybeResume(conv, msgIdx) {
    if (!conv || !conv.messages) return;
    const msg = conv.messages[msgIdx];
    if (!msg || !msg.resumePending) return;
    const ops = msg.fileOps || [];
    if (!ops.length) { msg.resumePending = false; save(); return; }
    if (ops.some(op => (op.status || 'pending') === 'pending')) return;
    let chatId = null;
    for (const id of Object.keys(conversations)) { if (conversations[id] === conv) chatId = id; }
    if (!chatId) return;
    // Reschedule (instead of dropping) while this chat is busy or not visible —
    // the resume fires when the stream ends or the user switches back (#82)
    if (isChatStreaming(chatId) || activeChatId !== chatId) { setTimeout(() => maybeResume(conv, msgIdx), 800); return; }
    msg.resumePending = false;
    save();
    const results = ops.map(op => ({ op: { type: op.type, path: op.path }, error: op.errMessage || null, skipped: op.status === 'skipped', content: (op.type === 'read_file' && op.status === 'applied') ? op.content : undefined }));
    setTimeout(() => resumeAfterFileOp(results, chatId), 300);
  }

  async function executeFileOp(op) {
    try {
      const res = performFileOp(op);
      const data = res && (await res);
      if (typeof data === 'string') return { error: data };
      if (data && data.notFound) return { content: null };
      if (data && data.value) return { error: data.value };
      if (data && data.content !== undefined) return { content: data.content };
      refreshFileTree();
      return null;
    } catch (e) { return { error: e.message }; }
  }

  function resumeAfterFileOp(results, chatId) {
    // Build a continuation message for the model
    const summary = results.map(r => {
      if (r.error) return `${r.op.type} ${r.op.path}: FAILED - ${r.error}`;
      if (r.op.type === 'read_file') {
        if (r.content === null || r.content === undefined) return `Read ${r.op.path}: file not found`;
        return `Read ${r.op.path}:\n${String(r.content).slice(0, 6000)}`;
      }
      return `${r.op.type} ${r.op.path}: ${r.skipped ? 'skipped' : 'done'}`;
    }).join('\n');
    const skippedOrFailed = results.some(r => r.error || r.skipped);
    const framing = skippedOrFailed
      ? `File operations result:\n\nSome operations were skipped or failed:\n${summary}\n\nWrap up now: answer in plain chat text, mention the file paths, and use NO further file tags unless the user asks (never put tags in code fences). If anything failed, tell the user plainly. Continue.`
      : `File operations result:\n${summary}\n\nThe files are written. Wrap up now: answer in plain chat text, mention the file paths, and use NO further file tags unless the user asks (never put tags in code fences). If anything failed, tell the user plainly. Continue.`;
    send(framing, { injected: true, chatId });
  }

  function checkResumeOnSwitch() {
    const c = activeChatId ? conversations[activeChatId] : null;
    if (!c || !c.messages) return;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      if (c.messages[i] && c.messages[i].resumePending) { maybeResume(c, i); return; }
    }
  }

  // File-op apply/skip (persisted per message) + search card collapse via event delegation
  document.getElementById('chat').addEventListener('click', function(e) {
    const searchHead = e.target.closest('.search-card-head');
    if (searchHead) {
      const card = searchHead.closest('.search-card');
      card.classList.toggle('collapsed');
      const row = card.closest('.message-assistant');
      const conv = activeChatId ? conversations[activeChatId] : null;
      const msg = row && conv && conv.messages ? conv.messages[Number(row.dataset.msgIdx)] : null;
      const entry = msg && card.dataset.searchIdx != null && msg.searchCards ? msg.searchCards[Number(card.dataset.searchIdx)] : null;
      if (entry) { entry.collapsed = card.classList.contains('collapsed'); save(); }
      return;
    }
    const applyBtn = e.target.closest('[data-apply-op]');
    if (applyBtn) {
      const msgIdx = Number(applyBtn.dataset.opMsg);
      const idx = Number(applyBtn.dataset.applyOp);
      const conv = activeChatId ? conversations[activeChatId] : null;
      const msg = conv && conv.messages ? conv.messages[msgIdx] : null;
      const op = msg && msg.fileOps ? msg.fileOps[idx] : null;
      if (!op || (op.status || 'pending') !== 'pending') return;
      const card = applyBtn.closest('.file-op-card');
      if (card.dataset.applying) return;
      card.dataset.applying = '1';
      const statusEl = card.querySelector('.file-op-status');
      applyBtn.disabled = true;
      const skipEl = card.querySelector('[data-skip-op]');
      if (skipEl) skipEl.disabled = true;
      executeFileOp(op).then(res => {
        const err = res && res.error;
        if (res && res.content !== undefined) op.content = res.content;
        op.status = err ? 'error' : 'applied';
        if (err) op.errMessage = err;
        if (statusEl) { statusEl.textContent = err ? `Error: ${err}` : 'Done'; statusEl.className = 'file-op-status ' + (err ? 'error' : 'done'); }
        save();
        card.style.transition = 'opacity 0.3s, transform 0.3s';
        setTimeout(() => { card.style.opacity = '0'; card.style.transform = 'scale(0.95)'; }, 200);
        setTimeout(() => { card.remove(); maybeResume(conv, msgIdx); }, 500);
      });
      return;
    }
    const skipBtn = e.target.closest('[data-skip-op]');
    if (skipBtn) {
      const msgIdx = Number(skipBtn.dataset.opMsg);
      const idx = Number(skipBtn.dataset.skipOp);
      const conv = activeChatId ? conversations[activeChatId] : null;
      const msg = conv && conv.messages ? conv.messages[msgIdx] : null;
      const op = msg && msg.fileOps ? msg.fileOps[idx] : null;
      if (!op || (op.status || 'pending') !== 'pending') return;
      const card = skipBtn.closest('.file-op-card');
      const statusEl = card.querySelector('.file-op-status');
      skipBtn.disabled = true;
      const applyEl = card.querySelector('[data-apply-op]');
      if (applyEl) applyEl.disabled = true;
      op.status = 'skipped';
      if (statusEl) { statusEl.textContent = 'Skipped'; statusEl.className = 'file-op-status'; }
      save();
      card.style.transition = 'opacity 0.3s, transform 0.3s';
      setTimeout(() => { card.style.opacity = '0'; card.style.transform = 'scale(0.95)'; }, 200);
      setTimeout(() => { card.remove(); maybeResume(conv, msgIdx); }, 500);
      return;
    }
  });

  // --- Init ---
  // Catch-all so a rejected promise anywhere (init, model loading, async handlers)
  // can never break input handling (#75)
  window.addEventListener('unhandledrejection', function(e) {
    try { console.error('Unhandled promise rejection in gooey:', e.reason); } catch {}
  });
  (async function() {
    try { webSearchEnabled = localStorage.getItem('gooey_websearch') !== '0'; } catch {}
    loadParams();
    await loadStorage();
    loadModels().catch(function(e) { try { console.error('loadModels failed:', e); } catch {} });
    renderSidebar();
    const lastActive = localStorage.getItem('gooey_active_chat');
    if (lastActive && conversations[lastActive]) {
      activeChatId = lastActive;
      if (conversations[lastActive].projectId) activeProjectId = conversations[lastActive].projectId;
      renderChat();
      updateTopbar();
      checkResumeOnSwitch();
    }
  })().catch(function(e) { try { console.error('gooey init failed:', e); } catch {} });
  setInterval(() => {
    if (!activeChatId) return;
    try { if (localStorage.getItem('gooey_active_chat') !== activeChatId) localStorage.setItem('gooey_active_chat', activeChatId); } catch {}
  }, 1000);
})();