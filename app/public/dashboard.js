const $ = s => document.querySelector(s);

let CSRF = null;
let boards = [];
let accounts = [];
let currentAccountId = null;
let pendingImage = null; // { data, mime } for base64 or null

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(path, opts = {}) {
  const headers = {};
  if (CSRF) headers['x-csrf-token'] = CSRF;
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function accountQS() { return currentAccountId ? `?account_id=${currentAccountId}` : ''; }

async function init() {
  const cfg = await api('/api/config');
  if (!cfg.signedIn) { location.href = '/'; return; }
  CSRF = (await api('/api/csrf')).token;
  if (!cfg.aiImageConfigured) {
    $('#ai-note').textContent = 'Set OPENAI_API_KEY in .env to enable AI images.';
    $('#ai-generate').disabled = true;
  }
  await loadAccounts();
  if (!currentAccountId) return;
  await Promise.all([loadBoards(), loadProducts(), renderAccountSettings(), loadAnalytics()]);
}

async function loadAnalytics() {
  if (!currentAccountId) return;
  try {
    const d = await api(`/api/accounts/${currentAccountId}/analytics?days=30`);
    $('#stat-impressions').textContent = fmt(d.impressions);
    $('#stat-saves').textContent = fmt(d.saves);
    $('#stat-pin-clicks').textContent = fmt(d.pin_clicks);
    $('#stat-outbound').textContent = fmt(d.outbound_clicks);
    $('#analytics-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    $('#analytics-updated').textContent = err.message;
  }
}

function fmt(n) {
  const x = Number(n || 0);
  if (x >= 1e6) return (x / 1e6).toFixed(1) + 'M';
  if (x >= 1e3) return (x / 1e3).toFixed(1) + 'K';
  return String(x);
}

async function loadAccounts() {
  accounts = await api('/api/accounts');
  const sel = $('#account-switcher');
  if (!accounts.length) {
    sel.innerHTML = '<option>(no accounts connected)</option>';
    sel.disabled = true;
    $('#no-account-card').hidden = false;
    currentAccountId = null;
    return;
  }
  sel.disabled = false;
  $('#no-account-card').hidden = true;
  sel.innerHTML = accounts.map(a =>
    `<option value="${a.id}">${escapeHtml('@' + (a.username || 'account ' + a.id))}</option>`
  ).join('');
  currentAccountId = accounts[0].id;
  sel.value = String(currentAccountId);
}

function renderAccountSettings() {
  const a = accounts.find(x => x.id == currentAccountId);
  if (!a) return;
  $('#cfg-daily').value = a.daily_pin_limit;
  $('#cfg-throttle').value = a.min_seconds_between_pins;
  $('#cfg-disclose').checked = a.auto_disclose;
  $('#posted-today').textContent = `${a.posted_last_24h} posted in last 24h / ${a.daily_pin_limit} limit`;
}

$('#cfg-save').addEventListener('click', async () => {
  try {
    await api(`/api/accounts/${currentAccountId}`, {
      method: 'PATCH',
      body: {
        daily_pin_limit: Number($('#cfg-daily').value),
        min_seconds_between_pins: Number($('#cfg-throttle').value),
        auto_disclose: $('#cfg-disclose').checked
      }
    });
    await loadAccounts();
    renderAccountSettings();
    $('#cfg-status').textContent = 'Saved';
    setTimeout(() => $('#cfg-status').textContent = '', 2000);
  } catch (err) { toast(err.message, true); }
});

$('#account-switcher').addEventListener('change', async e => {
  currentAccountId = Number(e.target.value);
  renderAccountSettings();
  await Promise.all([loadBoards(), loadProducts(), loadAnalytics()]);
});

$('#refresh-analytics').addEventListener('click', async () => {
  $('#refresh-analytics').disabled = true;
  $('#refresh-analytics').textContent = 'Refreshing…';
  try {
    await api('/api/analytics/refresh-all', { method: 'POST' });
    toast('Analytics refreshed');
    await loadAnalytics();
    await loadProducts();
  } catch (err) { toast(err.message, true); }
  $('#refresh-analytics').disabled = false;
  $('#refresh-analytics').textContent = 'Refresh all';
});

async function loadBoards() {
  try {
    boards = await api('/api/boards' + accountQS());
    const sel = $('#board');
    const prev = sel.value;
    sel.innerHTML = boards.length
      ? boards.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')
      : '<option value="">No boards yet — create one below</option>';
    if (prev && boards.some(b => b.id === prev)) sel.value = prev;
  } catch (err) { toast('Boards: ' + err.message, true); }
}

async function loadProducts() {
  const items = await api('/api/products' + accountQS());
  const wrap = $('#products');
  if (!items.length) {
    wrap.innerHTML = '<p class="muted">No products yet.</p>';
    return;
  }
  wrap.innerHTML = items.map(renderProduct).join('');
  wrap.querySelectorAll('[data-post]').forEach(b => b.addEventListener('click', () => postOne(b.dataset.post)));
  wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => delOne(b.dataset.del)));
  wrap.querySelectorAll('[data-stats]').forEach(b => b.addEventListener('click', () => refreshStats(b.dataset.stats)));
}

async function refreshStats(id) {
  try {
    await api(`/api/products/${id}/analytics/refresh`, { method: 'POST' });
    toast('Stats refreshed');
    await loadProducts();
  } catch (err) { toast(err.message, true); }
}

function renderProduct(p) {
  const pill = `<span class="pill ${p.status}">${p.status}</span>`;
  const mediaBadge = p.media_type === 'video' ? '<span class="pill video">video</span>' : '';
  const sched = p.scheduled_for
    ? `<small>scheduled ${new Date(p.scheduled_for * 1000).toLocaleString()}</small>` : '';
  const img = p.image_url ? escapeHtml(p.image_url) : '';
  const err = p.error ? `<small style="color:#a0181c">${escapeHtml(p.error)}</small>` : '';
  const inline = p.has_image_data ? '<small class="muted">uploaded image</small>' : '';

  const stats = p.status === 'posted' && p.last_analytics_at
    ? `<small class="stats-mini">
         <span>👁 ${fmt(p.impressions)}</span>
         <span>💾 ${fmt(p.saves)}</span>
         <span>📌 ${fmt(p.pin_clicks)}</span>
         <span>🔗 ${fmt(p.outbound_clicks)}</span>
       </small>` : '';

  const actions = p.status === 'posted'
    ? `<button class="btn small ghost" data-stats="${p.id}">Refresh stats</button>
       <button class="btn small ghost" data-del="${p.id}">Delete</button>`
    : `<button class="btn small primary" data-post="${p.id}">Post now</button>
       <button class="btn small ghost" data-del="${p.id}">Delete</button>`;
  return `
    <div class="product">
      ${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
            : `<div class="img-ph"></div>`}
      <div class="meta">
        <b>${escapeHtml(p.title)} ${pill} ${mediaBadge}</b>
        <small>${escapeHtml(p.affiliate_url)}</small>
        ${sched} ${inline} ${err}
        ${stats}
      </div>
      <div class="actions">${actions}</div>
    </div>`;
}

function selectedBoard() {
  const sel = $('#board');
  return { id: sel.value, name: sel.options[sel.selectedIndex]?.text };
}

// Image handling
$('#image-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  pendingImage = { data: b64, mime: f.type || 'image/jpeg' };
  $('#image-preview').src = `data:${pendingImage.mime};base64,${b64}`;
  $('#image-preview-wrap').hidden = false;
});

$('#clear-image').addEventListener('click', () => {
  pendingImage = null;
  $('#image-file').value = '';
  $('#image-preview-wrap').hidden = true;
});

$('#ai-generate').addEventListener('click', async () => {
  const prompt = $('#ai-prompt').value.trim();
  if (!prompt) return toast('Enter a prompt', true);
  $('#ai-generate').disabled = true;
  $('#ai-generate').textContent = 'Generating…';
  try {
    const r = await api('/api/ai/image', { method: 'POST', body: { prompt } });
    pendingImage = { data: r.image_base64, mime: r.image_mime };
    $('#image-preview').src = `data:${r.image_mime};base64,${r.image_base64}`;
    $('#image-preview-wrap').hidden = false;
  } catch (err) { toast(err.message, true); }
  $('#ai-generate').disabled = false;
  $('#ai-generate').textContent = 'Generate';
});

$('#scrape-btn').addEventListener('click', async () => {
  const url = $('#scrape-url').value.trim();
  if (!url) return;
  $('#scrape-btn').disabled = true;
  try {
    const d = await api('/api/scrape', { method: 'POST', body: { url } });
    const form = $('#product-form');
    if (d.title) form.elements.title.value = d.title.slice(0, 100);
    if (d.description) form.elements.description.value = d.description.slice(0, 500);
    if (d.image_url) form.elements.image_url.value = d.image_url;
    if (!form.elements.affiliate_url.value) form.elements.affiliate_url.value = url;
    toast('Filled from URL — add your affiliate link');
  } catch (err) { toast(err.message, true); }
  $('#scrape-btn').disabled = false;
});

$('#bulk-scrape-btn').addEventListener('click', async () => {
  const urls = $('#bulk-urls').value.split(/\s+/).filter(u => /^https?:\/\//.test(u));
  if (!urls.length) return toast('No URLs found', true);
  const board = selectedBoard();
  if (!board.id) return toast('Pick a board first', true);
  toast(`Fetching ${urls.length} URLs…`);
  try {
    const r = await api('/api/scrape/bulk', { method: 'POST', body: { urls } });
    let added = 0;
    for (const item of r.results) {
      if (!item.ok || !item.title || !item.image_url) continue;
      try {
        await api('/api/products' + accountQS(), {
          method: 'POST',
          body: {
            title: item.title.slice(0, 100),
            description: (item.description || '').slice(0, 500),
            image_url: item.image_url,
            affiliate_url: item.url,
            board_id: board.id,
            board_name: board.name
          }
        });
        added += 1;
      } catch {}
    }
    toast(`Added ${added} drafts (review and replace URLs with your affiliate links).`);
    $('#bulk-urls').value = '';
    await loadProducts();
  } catch (err) { toast(err.message, true); }
});

async function saveProduct(action) {
  const form = $('#product-form');
  const fd = new FormData(form);
  const board = selectedBoard();
  if (!board.id) return toast('Pick or create a board first', true);

  const body = new FormData();
  body.append('title', fd.get('title'));
  body.append('affiliate_url', fd.get('affiliate_url'));
  body.append('description', fd.get('description') || '');
  body.append('image_url', fd.get('image_url') || '');
  body.append('board_id', board.id);
  body.append('board_name', board.name);
  if (pendingImage) {
    body.append('image_base64', pendingImage.data);
    body.append('image_mime', pendingImage.mime);
  }
  const vf = $('#video-file').files[0];
  if (vf) {
    if (vf.size > 50 * 1024 * 1024) { toast('Video exceeds 50MB limit', true); return; }
    body.append('video', vf);
  }
  const cf = $('#cover-image-file').files[0];
  if (cf) body.append('cover_image', cf);
  let scheduledTs = null;
  if (action === 'schedule') {
    const v = fd.get('scheduled_for');
    if (!v) return toast('Pick a schedule time', true);
    scheduledTs = Math.floor(new Date(v).getTime() / 1000);
    body.append('scheduled_for', String(scheduledTs));
  }

  try {
    const res = await fetch('/api/products' + accountQS(), {
      method: 'POST',
      headers: { 'x-csrf-token': CSRF },
      body
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'save failed');

    if (action === 'queue') {
      await api(`/api/products/${data.id}/post`, { method: 'POST' });
      toast('Posted');
    } else if (action === 'schedule') {
      toast('Scheduled');
    } else {
      toast('Saved as draft');
    }
    form.reset();
    $('#clear-image').click();
    $('#video-file').value = '';
    $('#cover-image-file').value = '';
    $('#video-status').textContent = '';
    await loadProducts();
    await loadAccounts();
    renderAccountSettings();
  } catch (err) { toast(err.message, true); await loadProducts(); }
}

$('#product-form').addEventListener('submit', e => { e.preventDefault(); saveProduct('draft'); });
$('#save-and-queue').addEventListener('click', () => saveProduct('queue'));
$('#save-and-schedule').addEventListener('click', () => saveProduct('schedule'));

$('#refresh-boards').addEventListener('click', loadBoards);
$('#create-board').addEventListener('click', async () => {
  const name = $('#new-board-name').value.trim();
  if (!name) return toast('Board name required', true);
  try {
    await api('/api/boards' + accountQS(), { method: 'POST', body: { name, description: $('#new-board-desc').value } });
    $('#new-board-name').value = ''; $('#new-board-desc').value = '';
    toast('Board created');
    await loadBoards();
  } catch (err) { toast(err.message, true); }
});

$('#csv-form').addEventListener('submit', async e => {
  e.preventDefault();
  const file = $('#csv-file').files[0];
  if (!file) return;
  const board = selectedBoard();
  const fd = new FormData();
  fd.append('file', file);
  if (board.id) { fd.append('board_id', board.id); fd.append('board_name', board.name); }
  const res = await fetch('/api/products/import-csv' + accountQS(), {
    method: 'POST',
    headers: { 'x-csrf-token': CSRF },
    body: fd
  });
  const data = await res.json();
  if (!res.ok) toast(data.error, true);
  else {
    toast(`Imported ${data.added}${data.skipped ? `, skipped ${data.skipped}` : ''}`);
    $('#csv-file').value = '';
    await loadProducts();
  }
});

async function postOne(id) {
  try {
    await api(`/api/products/${id}/post`, { method: 'POST' });
    toast('Posted');
  } catch (err) { toast(err.message, true); }
  await loadProducts();
  await loadAccounts();
  renderAccountSettings();
}

async function delOne(id) {
  if (!confirm('Delete this product?')) return;
  await api(`/api/products/${id}`, { method: 'DELETE' });
  await loadProducts();
}

$('#queue-all').addEventListener('click', async () => {
  if (!confirm('Queue all drafts/failed for posting? The scheduler will post them respecting your rate limits.')) return;
  try {
    const r = await api('/api/products/queue-all', { method: 'POST', body: { account_id: currentAccountId } });
    toast(`Queued ${r.queued}. Scheduler will post them.`);
    await loadProducts();
  } catch (err) { toast(err.message, true); }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
});

$('#video-file')?.addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) { $('#video-status').textContent = ''; return; }
  const mb = (f.size / 1024 / 1024).toFixed(1);
  if (f.size > 50 * 1024 * 1024) {
    $('#video-status').innerHTML = `<span style="color:#a0181c">Selected ${mb}MB — exceeds 50MB limit</span>`;
  } else {
    $('#video-status').textContent = `Selected: ${f.name} (${mb}MB). Remember to set a cover image or Image URL.`;
  }
});

init();
