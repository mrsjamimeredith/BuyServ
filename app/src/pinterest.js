const API_BASE = 'https://api.pinterest.com/v5';
const OAUTH_BASE = 'https://www.pinterest.com/oauth';
const TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';

const SCOPES = [
  'user_accounts:read',
  'pins:read',
  'pins:write',
  'boards:read',
  'boards:write'
].join(',');

function authUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.PINTEREST_CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state
  });
  return `${OAUTH_BASE}/?${params.toString()}`;
}

function basicAuthHeader() {
  const creds = `${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.REDIRECT_URI
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshToken(refresh) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    scope: SCOPES
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiFetch(accessToken, path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.message || data?.error || text || res.statusText;
    const err = new Error(`Pinterest API ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function getUser(accessToken) {
  return apiFetch(accessToken, '/user_account');
}

async function listBoards(accessToken) {
  const out = [];
  let bookmark = null;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (bookmark) qs.set('bookmark', bookmark);
    const data = await apiFetch(accessToken, `/boards?${qs.toString()}`);
    out.push(...(data.items || []));
    bookmark = data.bookmark || null;
  } while (bookmark);
  return out;
}

async function createBoard(accessToken, name, description = '') {
  return apiFetch(accessToken, '/boards', {
    method: 'POST',
    body: JSON.stringify({ name, description, privacy: 'PUBLIC' })
  });
}

async function createPin(accessToken, { title, description, boardId, imageUrl, link }) {
  const body = {
    board_id: boardId,
    title: (title || '').slice(0, 100),
    description: (description || '').slice(0, 500),
    link,
    media_source: {
      source_type: 'image_url',
      url: imageUrl
    }
  };
  return apiFetch(accessToken, '/pins', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

module.exports = {
  authUrl,
  exchangeCode,
  refreshToken,
  getUser,
  listBoards,
  createBoard,
  createPin
};
