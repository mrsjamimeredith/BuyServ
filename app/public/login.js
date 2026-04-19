const $ = s => document.querySelector(s);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function init() {
  const cfg = await api('/api/config');
  if (cfg.signedIn) { location.href = '/dashboard.html'; return; }
  if (cfg.missingEnv?.length) {
    $('#setup-env').hidden = false;
    $('#missing-vars').textContent = 'Missing: ' + cfg.missingEnv.join(', ');
    return;
  }
  if (!cfg.setupDone) {
    $('#setup-admin').hidden = false;
  } else {
    $('#login').hidden = false;
  }
}

$('#setup-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const password = f.get('password');
  const confirm = f.get('confirm');
  if (password !== confirm) { alert('Passwords do not match'); return; }
  try {
    await api('/api/setup', { method: 'POST', body: { username: f.get('username'), password } });
    location.href = '/dashboard.html';
  } catch (err) { alert(err.message); }
});

$('#login-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    location.href = '/dashboard.html';
  } catch (err) { $('#login-err').textContent = err.message; }
});

init();
