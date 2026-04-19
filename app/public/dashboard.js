const $ = s => document.querySelector(s);

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body instanceof FormData ? opts.body :
          opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let boards = [];

async function init() {
  const cfg = await api('/api/config');
  if (!cfg.signedIn) { location.href = '/'; return; }
  $('#who').textContent = cfg.username ? `@${cfg.username}` : 'Connected';
  await loadBoards();
  await loadProducts();
}

async function loadBoards() {
  try {
    boards = await api('/api/boards');
    const sel = $('#board');
    const prev = sel.value;
    sel.innerHTML = boards.length
      ? boards.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')
      : '<option value="">No boards yet — create one below</option>';
    if (prev && boards.some(b => b.id === prev)) sel.value = prev;
  } catch (err) {
    toast('Could not load boards: ' + err.message, true);
  }
}

async function loadProducts() {
  const items = await api('/api/products');
  const wrap = $('#products');
  if (!items.length) {
    wrap.innerHTML = '<p class="muted">No products yet. Add one above or upload a CSV.</p>';
    return;
  }
  wrap.innerHTML = items.map(p => renderProduct(p)).join('');
  wrap.querySelectorAll('[data-post]').forEach(b => b.addEventListener('click', () => postOne(b.dataset.post)));
  wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => delOne(b.dataset.del)));
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderProduct(p) {
  const pill = `<span class="pill ${p.status}">${p.status}</span>`;
  const actions = p.status === 'posted'
    ? `<button class="btn small ghost" data-del="${p.id}">Delete</button>`
    : `<button class="btn small primary" data-post="${p.id}">Post now</button>
       <button class="btn small ghost" data-del="${p.id}">Delete</button>`;
  const err = p.error ? `<small style="color:#a0181c">${escapeHtml(p.error)}</small>` : '';
  return `
    <div class="product">
      <img src="${escapeHtml(p.image_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <div class="meta">
        <b>${escapeHtml(p.title)} ${pill}</b>
        <small>${escapeHtml(p.affiliate_url)}</small>
        ${err}
      </div>
      <div class="actions">${actions}</div>
    </div>`;
}

function selectedBoard() {
  const sel = $('#board');
  const id = sel.value;
  const name = sel.options[sel.selectedIndex]?.text;
  return { id, name };
}

async function saveProduct(form, postNow) {
  const data = Object.fromEntries(new FormData(form).entries());
  const board = selectedBoard();
  if (!board.id) { toast('Pick or create a board first', true); return; }
  data.board_id = board.id;
  data.board_name = board.name;
  try {
    const created = await api('/api/products', { method: 'POST', body: data });
    toast('Saved');
    form.reset();
    if (postNow) {
      await api(`/api/products/${created.id}/post`, { method: 'POST' });
      toast('Posted to Pinterest');
    }
    await loadProducts();
  } catch (err) {
    toast(err.message, true);
    await loadProducts();
  }
}

async function postOne(id) {
  try {
    await api(`/api/products/${id}/post`, { method: 'POST' });
    toast('Posted');
  } catch (err) {
    toast(err.message, true);
  }
  await loadProducts();
}

async function delOne(id) {
  if (!confirm('Delete this product?')) return;
  await api(`/api/products/${id}`, { method: 'DELETE' });
  await loadProducts();
}

$('#product-form').addEventListener('submit', e => {
  e.preventDefault();
  saveProduct(e.target, false);
});
$('#save-and-post').addEventListener('click', () => saveProduct($('#product-form'), true));

$('#refresh-boards').addEventListener('click', loadBoards);
$('#create-board').addEventListener('click', async () => {
  const name = $('#new-board-name').value.trim();
  if (!name) return toast('Board name required', true);
  try {
    await api('/api/boards', { method: 'POST', body: { name, description: $('#new-board-desc').value } });
    $('#new-board-name').value = '';
    $('#new-board-desc').value = '';
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
  try {
    const r = await api('/api/products/import-csv', { method: 'POST', body: fd });
    toast(`Imported ${r.added} products${r.skipped ? `, skipped ${r.skipped}` : ''}`);
    $('#csv-file').value = '';
    await loadProducts();
  } catch (err) { toast(err.message, true); }
});

$('#post-all').addEventListener('click', async () => {
  if (!confirm('Post all draft and failed products now?')) return;
  $('#post-all').disabled = true;
  try {
    const r = await api('/api/products/post-all', { method: 'POST' });
    const ok = r.results.filter(x => x.ok).length;
    const fail = r.results.length - ok;
    toast(`Posted ${ok}${fail ? `, ${fail} failed` : ''}`);
  } catch (err) { toast(err.message, true); }
  $('#post-all').disabled = false;
  await loadProducts();
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/';
});

init();
