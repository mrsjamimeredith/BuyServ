const $ = s => document.querySelector(s);
let CSRF = null;
let ME = null;

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', !!err);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (CSRF) headers['x-csrf-token'] = CSRF;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function init() {
  const cfg = await api('/api/config');
  if (!cfg.signedIn) { location.href = '/'; return; }
  ME = cfg.me;
  $('#me').textContent = `${ME.username} (${ME.role})`;
  if (ME.role !== 'admin') {
    document.querySelectorAll('#users, #new-user-form').forEach(el => el.closest('.card').style.opacity = 0.4);
  }
  CSRF = (await api('/api/csrf')).token;
  if (ME.role === 'admin') await loadUsers();
}

async function loadUsers() {
  try {
    const users = await api('/api/users');
    $('#users').innerHTML = users.map(u => `
      <div class="user-row">
        <b>${escapeHtml(u.username)}</b>
        <select class="input small" data-role="${u.id}" ${u.id === ME.id ? 'disabled' : ''}>
          ${['admin','editor','viewer'].map(r =>
            `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        ${u.id === ME.id ? '<span class="muted small">(you)</span>' : `
          <button class="btn small ghost" data-del="${u.id}">Delete</button>`}
      </div>
    `).join('');
    $('#users').querySelectorAll('[data-role]').forEach(sel =>
      sel.addEventListener('change', async e => {
        try {
          await api(`/api/users/${sel.dataset.role}`, { method: 'PATCH', body: { role: e.target.value } });
          toast('Role updated');
        } catch (err) { toast(err.message, true); await loadUsers(); }
      }));
    $('#users').querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!confirm('Delete this user?')) return;
        try {
          await api(`/api/users/${b.dataset.del}`, { method: 'DELETE' });
          toast('Deleted');
          await loadUsers();
        } catch (err) { toast(err.message, true); }
      }));
  } catch (err) { toast(err.message, true); }
}

$('#new-user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/users', { method: 'POST', body: {
      username: f.get('username'),
      password: f.get('password'),
      role: f.get('role')
    }});
    toast('User created');
    e.target.reset();
    await loadUsers();
  } catch (err) { toast(err.message, true); }
});

$('#pw-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/me/password', { method: 'POST', body: {
      current: f.get('current'), next: f.get('next')
    }});
    toast('Password updated');
    e.target.reset();
  } catch (err) { toast(err.message, true); }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
});

init();
