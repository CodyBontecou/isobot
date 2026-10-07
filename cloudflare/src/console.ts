/** Read-only viewer. Authentication stays in browser memory and is sent only to this origin. */
export function consoleResponse(): Response {
  const nonce = crypto.randomUUID();
  const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Pi conversation viewer</title>
  <style nonce="${nonce}">
    :root{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8eaef;background:#111317;font-synthesis:none;line-height:1.5}
    *{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{cursor:pointer;border:1px solid #393e49;background:#272c35;color:#f2f3f6;padding:8px 14px;border-radius:8px;font-weight:600}button:hover{background:#353b47}button:disabled{opacity:.45;cursor:default}input{background:#11151c;border:1px solid #3a414f;border-radius:8px;padding:9px 12px;color:#f3f4f7;min-width:0}input:focus-visible,button:focus-visible{outline:2px solid #b8adfa;outline-offset:3px}a{color:#c6bcff}.wrap{max-width:1440px;margin:auto;padding:28px 32px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:26px}.brand{font-weight:750;letter-spacing:-.7px;font-size:25px}h1,h2,h3,p{margin:0}h1{font-size:22px;letter-spacing:-.3px}h2{font-size:16px}h3{font-size:14px}.muted{color:#9ca5b4;font-size:13px}.subtitle{margin-top:5px}.panel{background:#191d24;border:1px solid #303540;border-radius:12px}.connect{padding:22px;margin-bottom:22px}.connect form{display:flex;gap:10px;margin-top:15px;max-width:620px}.connect input{flex:1}.connect p{margin-top:6px}.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-bottom:18px}.field{display:flex;flex-direction:column;gap:5px}.field label{font-size:12px;font-weight:600;color:#aab2c1}.field input{width:260px}.toolbar .muted{margin-left:auto;padding-bottom:8px}.status{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:13px 17px;margin-bottom:20px}.dot{width:7px;height:7px;background:#90d4b1;border-radius:100%;display:inline-block}.dot.busy{background:#eec980}.pill{display:inline-block;border:1px solid #424a59;color:#bfc7d5;border-radius:5px;padding:1px 6px;font-size:11px;line-height:1.7;white-space:nowrap}.pill.memory{border-color:#416453;color:#a9d7bc}.pill.prompt{border-color:#62578c;color:#cfbcff}.error{color:#ffc5c7;background:#2c1e26;border:1px solid #68404b;border-radius:8px;padding:11px 15px;margin:0 0 18px;font-size:14px}.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(340px,1fr);gap:20px;align-items:start}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 19px;border-bottom:1px solid #303540}.panel-head button{padding:5px 10px;font-size:12px}.timeline{padding:8px 19px 19px;min-height:240px}.entry{padding:16px 0;border-bottom:1px solid #2e333d}.entry:last-child{border-bottom:none}.entry-head{display:flex;align-items:center;gap:8px;margin-bottom:7px}.role{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px}.role.user{color:#b5cbf2}.role.assistant{color:#d3c4ff}.role.tool{color:#b3cbbf}.entry-body,.markdown{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.65}.entry-body{max-width:84ch}.entry pre,.detail pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;background:#12161c;border:1px solid #2c333e;border-radius:8px;padding:10px;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}.entry details{margin-top:8px}.entry summary,.detail summary{cursor:pointer;color:#aeb8c8;font-size:12px;overflow-wrap:anywhere}.empty{color:#a6afbe;font-size:14px;line-height:1.65;padding:26px 0}.capture-list{padding:8px}.capture{display:block;text-align:left;width:100%;background:transparent;border:1px solid transparent;padding:11px;border-radius:8px;font-weight:400;margin:1px 0}.capture:hover{background:#252b35}.capture.selected{border-color:#6c5d9c;background:#272434}.capture-top{display:flex;gap:8px;align-items:center;margin-bottom:5px}.capture-time{margin-left:auto;font-size:11px;color:#9aa5b6}.preview{font-size:13px;color:#ccd2df;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.capture-state{font-size:11px;color:#99a4b5}.detail{padding:17px 19px;border-top:1px solid #303540}.detail-title{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-bottom:9px}.detail-id{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#949fb0;overflow-wrap:anywhere;margin-bottom:14px}.downloads{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 17px}.downloads button{font-size:12px;padding:6px 9px}.detail h3{margin:17px 0 7px}.detail details{margin-top:17px}.loading{opacity:.6}.hidden{display:none!important}footer{margin-top:23px;font-size:12px;color:#838e9f}.disconnect{background:transparent;font-size:12px;padding:6px 10px}.pending{font-size:12px;overflow-wrap:anywhere;color:#dccaa2}.capture-footer{padding:0 19px 14px}.capture-footer button{font-size:12px;width:100%}
    @media(max-width:900px){.wrap{padding:22px 18px}.grid{grid-template-columns:1fr}.toolbar .muted{margin-left:0;width:100%;padding:0}.field{flex:1}.field input{width:100%}.connect form{flex-wrap:wrap}.connect input{min-width:180px}.brand{font-size:22px}}@media(prefers-reduced-motion:no-preference){button{transition:background .12s,border-color .12s}}
  </style>
</head>
<body>
<div class="wrap">
  <header><div><div class="brand">Pi</div><h1>Conversations &amp; captures</h1><p class="muted subtitle">Read your agent’s replies, tool activity, and saved Vox notes.</p></div><button id="disconnect" class="disconnect hidden" type="button">Disconnect</button></header>
  <section class="panel connect" id="connect-panel"><h2>Connect to your agent</h2><p class="muted">Paste the same bearer token you use in Vox. It stays in this tab until you disconnect or close it.</p><form id="connect-form"><input id="token" type="password" placeholder="Bearer token" aria-label="Bearer token" autocomplete="off" autocapitalize="off" spellcheck="false" required><button type="submit">Connect</button></form></section>
  <div id="error" class="error hidden" role="alert"></div>
  <main id="viewer" class="hidden">
    <form class="toolbar" id="conversation-form"><div class="field"><label for="conversation">Conversation</label><input id="conversation" value="vox" pattern="[A-Za-z0-9_-]{1,100}" maxlength="100" autocomplete="off" spellcheck="false" required></div><button id="refresh" type="submit">Refresh</button><p class="muted" id="updated"></p></form>
    <div class="panel status" id="agent-status" aria-live="polite"></div>
    <div class="grid">
      <section class="panel"><div class="panel-head"><h2>Conversation</h2><button id="older" type="button" class="hidden">Load earlier</button></div><div id="timeline" class="timeline"></div></section>
      <section class="panel"><div class="panel-head"><h2>Saved captures</h2><span class="muted" id="capture-count"></span></div><div id="captures" class="capture-list"></div><div class="capture-footer"><button id="older-captures" class="hidden" type="button">Load older captures</button></div><div id="detail" class="detail hidden"></div></section>
    </div>
  </main>
  <footer>Memory captures are stored without running Pi. Prompt captures also appear in the conversation once processed.</footer>
</div>
<script nonce="${nonce}">
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { token: '', conversation: 'vox', entries: [], notes: [], cursor: undefined, noteCursor: undefined, selected: undefined, epoch: 0, timer: undefined, loading: false };
  const initialConversation = new URL(location.href).searchParams.get('conversation');
  if (initialConversation && /^[A-Za-z0-9_-]{1,100}$/.test(initialConversation)) { state.conversation = initialConversation; $('conversation').value = initialConversation; }
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
  const showError = message => { $('error').textContent = message; $('error').classList.remove('hidden'); };
  const clearError = () => { $('error').replaceChildren(); $('error').classList.add('hidden'); };
  const stamp = value => { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const pretty = value => { if (typeof value === 'string') return value; try { return JSON.stringify(value, null, 2); } catch { return 'Unavailable'; } };
  function query(path, extra = {}) { const url = new URL(path, location.origin); url.searchParams.set('conversation', state.conversation); for (const [key, value] of Object.entries(extra)) if (value !== undefined) url.searchParams.set(key, String(value)); return url; }
  function stopPolling() { if (state.timer) clearTimeout(state.timer); state.timer = undefined; }
  function disconnect() {
    stopPolling(); state.token = ''; state.epoch++; state.entries = []; state.notes = []; state.selected = undefined;
    $('token').value = ''; $('viewer').classList.add('hidden'); $('disconnect').classList.add('hidden'); $('connect-panel').classList.remove('hidden');
    $('timeline').replaceChildren(); $('captures').replaceChildren(); $('detail').replaceChildren(); $('detail').classList.add('hidden'); $('token').focus();
  }
  async function request(url) {
    if (!state.token) throw new Error('Connect with your bearer token first.');
    const response = await fetch(url, { headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (response.status === 401) { const message = 'The token was not accepted. Paste your Vox bearer token and connect again.'; disconnect(); showError(message); throw new Error(message); }
    if (!response.ok) { let body; try { body = await response.json(); } catch {} throw new Error(body && typeof body.error === 'string' ? body.error : 'The request failed (' + response.status + '). Try refreshing.'); }
    return response;
  }
  const json = async url => (await request(url)).json();
  function disclosure(title, content) { const details = el('details'); details.append(el('summary', title), el('pre', pretty(content))); return details; }
  function renderTimeline() {
    const timeline = $('timeline'); timeline.replaceChildren();
    if (!state.entries.length) { timeline.append(el('p', 'No conversation messages yet. Memory captures are stored in Saved captures; they do not run Pi or create a reply. A prompt capture will appear here after processing.', 'empty')); return; }
    for (const entry of state.entries) {
      const article = el('article', undefined, 'entry'); const head = el('div', undefined, 'entry-head');
      const role = ['user', 'assistant', 'tool', 'system'].includes(entry.role) ? entry.role : 'system';
      head.append(el('span', role === 'assistant' ? 'Pi' : role, 'role ' + role));
      if (entry.createdAt) head.append(el('span', stamp(entry.createdAt), 'muted'));
      if (entry.toolResult) head.append(el('span', entry.toolResult.error ? 'Tool error' : 'Tool result', 'pill'));
      article.append(head);
      if (entry.text) article.append(el('div', entry.text, 'entry-body'));
      if (Array.isArray(entry.toolCalls)) for (const call of entry.toolCalls) article.append(disclosure('Tool: ' + (call.name || 'unknown'), call.arguments));
      if (entry.toolResult) article.append(disclosure('Tool details: ' + (entry.toolResult.name || 'unknown'), entry.toolResult));
      timeline.append(article);
    }
  }
  function renderStatus(data) {
    const box = $('agent-status'); box.replaceChildren(); const dot = el('span', undefined, 'dot' + (data.busy ? ' busy' : '')); dot.setAttribute('aria-hidden', 'true');
    box.append(dot, el('strong', data.busy ? 'Pi is working' : 'Ready'));
    if (data.model) box.append(el('span', typeof data.model === 'string' ? data.model : pretty(data.model), 'muted'));
    const pending = Array.isArray(data.pending) ? data.pending : [];
    if (pending.length) box.append(el('span', pending.length + ' pending', 'pill'));
    if (pending.length) { const details = el('details'); details.append(el('summary', 'Pending work')); for (const item of pending) details.append(el('div', (item.operationId || 'Operation') + ' · ' + (item.status || 'pending'), 'pending')); box.append(details); }
  }
  function renderCaptures() {
    const list = $('captures'); list.replaceChildren(); $('capture-count').textContent = state.notes.length ? String(state.notes.length) + ' loaded' : '';
    if (!state.notes.length) { list.append(el('p', 'No saved captures in this conversation. Check the conversation name in your Vox HTTP URL.', 'empty')); return; }
    for (const note of state.notes) {
      const button = el('button', undefined, 'capture' + (note.id === state.selected ? ' selected' : '')); button.type = 'button';
      const top = el('div', undefined, 'capture-top'); top.append(el('span', note.mode === 'memory' ? 'Memory' : 'Prompt', 'pill ' + (note.mode === 'memory' ? 'memory' : 'prompt')), el('span', note.status || 'stored', 'capture-state'), el('span', stamp(note.receivedAt), 'capture-time'));
      button.append(top, el('div', note.preview || '(Empty capture)', 'preview')); button.addEventListener('click', () => selectNote(note.id)); list.append(button);
    }
  }
  async function download(id, suffix, filename) {
    try {
      clearError(); const response = await request(query('/api/notes/' + encodeURIComponent(id) + suffix));
      if (response.status === 202) throw new Error('Pi is still working. Refresh to check for its response.');
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = el('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showError(error.message || 'The download failed.'); }
  }
  function downloadButton(title, id, suffix, filename) { const button = el('button', title); button.type = 'button'; button.addEventListener('click', () => download(id, suffix, filename)); return button; }
  async function selectNote(id) {
    const epoch = state.epoch; state.selected = id; renderCaptures(); const detail = $('detail'); detail.classList.remove('hidden'); detail.replaceChildren(el('p', 'Loading capture…', 'muted'));
    try {
      const note = await json(query('/api/notes/' + encodeURIComponent(id)));
      if (epoch !== state.epoch || id !== state.selected) return;
      const summary = state.notes.find(item => item.id === id); if (summary) { summary.status = note.status; renderCaptures(); }
      const metadata = state.notes.find(item => item.id === id); if (metadata && note.status) { metadata.status = note.status; renderCaptures(); }
      detail.replaceChildren(); const title = el('div', undefined, 'detail-title'); title.append(el('h2', 'Capture'), el('span', note.mode === 'memory' ? 'Memory' : 'Prompt', 'pill ' + (note.mode === 'memory' ? 'memory' : 'prompt')), el('span', note.status || 'stored', 'pill'));
      detail.append(title, el('p', stamp(note.receivedAt), 'muted'), el('p', note.id, 'detail-id'));
      const actions = el('div', undefined, 'downloads'); actions.append(downloadButton('Download Markdown', id, '.md', id + '.md'), downloadButton('Source JSON', id, '/source.json', id + '.source.json'));
      if (note.result && note.result.status === 'done') actions.append(downloadButton('Download response', id, '/response.md', id + '.response.md'));
      detail.append(actions, el('h3', 'Original Markdown'), el('div', note.markdown || '', 'markdown'));
      if (note.result) { detail.append(el('h3', 'Pi response'), el('div', note.result.text || 'Pi did not return an answer.', 'markdown')); if (note.result.reason) detail.append(el('p', note.result.reason, 'muted')); }
      else if (note.mode === 'prompt') detail.append(el('p', 'Pi’s response will appear here when processing finishes. Refresh to check again.', 'muted'));
      else detail.append(el('p', 'Stored as memory. Pi can search this capture when you ask about it in the same conversation.', 'muted'));
      detail.append(disclosure('Capture metadata', note.payload || {}));
    } catch (error) { if (epoch === state.epoch) { detail.replaceChildren(el('p', error.message || 'Could not load this capture.', 'muted')); showError(error.message || 'Could not load this capture.'); } }
  }
  async function refresh() {
    if (state.loading || !state.token) return;
    const conversation = $('conversation').value.trim(); if (!/^[A-Za-z0-9_-]{1,100}$/.test(conversation)) { showError('Use 1–100 letters, digits, underscores, or hyphens for the conversation name.'); return; }
    stopPolling(); clearError(); state.loading = true; $('refresh').disabled = true; $('viewer').classList.add('loading');
    if (conversation !== state.conversation) { state.selected = undefined; state.entries = []; state.notes = []; state.cursor = undefined; state.noteCursor = undefined; $('detail').classList.add('hidden'); $('older').classList.add('hidden'); $('older-captures').classList.add('hidden'); $('timeline').replaceChildren(el('p', 'Loading conversation…', 'empty')); $('captures').replaceChildren(el('p', 'Loading captures…', 'empty')); $('capture-count').textContent = ''; $('agent-status').replaceChildren(el('span', 'Loading conversation…', 'muted')); }
    state.conversation = conversation; const epoch = ++state.epoch;
    try {
      const results = await Promise.allSettled([json(query('/api/conversation', { limit: 100 })), json(query('/api/notes', { limit: 25 }))]);
      if (epoch !== state.epoch) return;
      const failures = [];
      if (results[0].status === 'fulfilled') { const data = results[0].value; state.entries = Array.isArray(data.entries) ? data.entries : []; state.cursor = data.nextCursor; renderTimeline(); renderStatus(data); $('older').classList.toggle('hidden', state.cursor === undefined || state.cursor === null); if (data.busy || (Array.isArray(data.pending) && data.pending.length)) state.timer = setTimeout(refresh, 10000); }
      else failures.push(results[0].reason.message || 'Could not load the conversation.');
      if (results[1].status === 'fulfilled') { const data = results[1].value; state.notes = Array.isArray(data.items) ? data.items : []; state.noteCursor = data.nextCursor; renderCaptures(); $('older-captures').classList.toggle('hidden', state.noteCursor === undefined || state.noteCursor === null); if (state.notes.length) await selectNote(state.notes.some(note => note.id === state.selected) ? state.selected : state.notes[0].id); else { state.selected = undefined; $('detail').classList.add('hidden'); } }
      else failures.push(results[1].reason.message || 'Could not load saved captures.');
      if (failures.length) showError([...new Set(failures)].join(' '));
      $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (error) { showError(error.message || 'Could not refresh.'); }
    finally { state.loading = false; $('refresh').disabled = false; $('viewer').classList.remove('loading'); }
  }
  $('connect-form').addEventListener('submit', event => { event.preventDefault(); state.token = $('token').value.trim().replace(/^Bearer\s+/i, ''); $('token').value = ''; if (!state.token) { showError('Paste your bearer token to connect.'); return; } $('connect-panel').classList.add('hidden'); $('disconnect').classList.remove('hidden'); $('viewer').classList.remove('hidden'); refresh(); });
  $('disconnect').addEventListener('click', () => { disconnect(); clearError(); });
  $('conversation-form').addEventListener('submit', event => { event.preventDefault(); refresh(); });
  $('older').addEventListener('click', async () => { const button = $('older'); const epoch = state.epoch; button.disabled = true; try { clearError(); const data = await json(query('/api/conversation', { limit: 100, before: state.cursor })); if (epoch !== state.epoch) return; const known = new Set(state.entries.map(entry => entry.id)); state.entries = (Array.isArray(data.entries) ? data.entries.filter(entry => !known.has(entry.id)) : []).concat(state.entries); state.cursor = data.nextCursor; renderTimeline(); button.classList.toggle('hidden', state.cursor === undefined || state.cursor === null); } catch (error) { showError(error.message || 'Could not load earlier messages.'); } finally { button.disabled = false; } });
  $('older-captures').addEventListener('click', async () => { const button = $('older-captures'); const epoch = state.epoch; button.disabled = true; try { clearError(); const data = await json(query('/api/notes', { limit: 25, before: state.noteCursor })); if (epoch !== state.epoch) return; const known = new Set(state.notes.map(note => note.id)); state.notes.push(...(Array.isArray(data.items) ? data.items.filter(note => !known.has(note.id)) : [])); state.noteCursor = data.nextCursor; renderCaptures(); button.classList.toggle('hidden', state.noteCursor === undefined || state.noteCursor === null); } catch (error) { showError(error.message || 'Could not load older captures.'); } finally { button.disabled = false; } });
})();
</script>
</body>
</html>`;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}
