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
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
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
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
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

async function createPin(accessToken, { title, description, boardId, imageUrl, imageData, imageMime, link, videoMediaId, coverImageData, coverImageMime, coverImageUrl }) {
  let mediaSource;
  if (videoMediaId) {
    mediaSource = {
      source_type: 'video_id',
      media_id: videoMediaId,
      ...(coverImageData
        ? { cover_image_content_type: coverImageMime || 'image/jpeg', cover_image_data: coverImageData }
        : coverImageUrl ? { cover_image_url: coverImageUrl } : {})
    };
  } else if (imageData) {
    mediaSource = { source_type: 'image_base64', content_type: imageMime || 'image/jpeg', data: imageData };
  } else {
    mediaSource = { source_type: 'image_url', url: imageUrl };
  }
  const body = {
    board_id: boardId,
    title: (title || '').slice(0, 100),
    description: (description || '').slice(0, 500),
    link,
    media_source: mediaSource
  };
  return apiFetch(accessToken, '/pins', { method: 'POST', body: JSON.stringify(body) });
}

// ---------- Video media upload (2-step register -> upload -> poll) ----------

async function registerVideoUpload(accessToken) {
  return apiFetch(accessToken, '/media', {
    method: 'POST',
    body: JSON.stringify({ media_type: 'video' })
  });
}

async function uploadVideoToS3(registration, videoBuffer, contentType) {
  const { upload_url, upload_parameters } = registration;
  const form = new FormData();
  // Pinterest requires upload_parameters first, then file key last
  for (const [k, v] of Object.entries(upload_parameters || {})) form.append(k, v);
  form.append('file', new Blob([videoBuffer], { type: contentType || 'video/mp4' }));
  const res = await fetch(upload_url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Video upload to storage failed: ${res.status} ${text.slice(0, 300)}`);
  }
}

async function getMediaStatus(accessToken, mediaId) {
  return apiFetch(accessToken, `/media/${mediaId}`);
}

async function waitForMediaReady(accessToken, mediaId, { maxWaitMs = 5 * 60 * 1000, intervalMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await getMediaStatus(accessToken, mediaId);
    if (status.status === 'succeeded') return status;
    if (status.status === 'failed') throw new Error('Video processing failed on Pinterest');
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Video processing timed out');
}

async function uploadVideo(accessToken, videoBuffer, contentType = 'video/mp4') {
  const reg = await registerVideoUpload(accessToken);
  await uploadVideoToS3(reg, videoBuffer, contentType);
  await waitForMediaReady(accessToken, reg.media_id);
  return reg.media_id;
}

// ---------- Analytics ----------

function formatDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const PIN_METRICS = ['IMPRESSION', 'SAVE', 'PIN_CLICK', 'OUTBOUND_CLICK'];

async function getPinAnalytics(accessToken, pinId, days = 30) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const qs = new URLSearchParams({
    start_date: formatDate(start),
    end_date: formatDate(end),
    metric_types: PIN_METRICS.join(','),
    app_types: 'ALL'
  });
  return apiFetch(accessToken, `/pins/${pinId}/analytics?${qs.toString()}`);
}

async function getUserAnalytics(accessToken, days = 30) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const qs = new URLSearchParams({
    start_date: formatDate(start),
    end_date: formatDate(end),
    metric_types: PIN_METRICS.join(','),
    from_claimed_content: 'BOTH',
    pin_format: 'ALL',
    app_types: 'ALL'
  });
  return apiFetch(accessToken, `/user_account/analytics?${qs.toString()}`);
}

module.exports = {
  authUrl,
  exchangeCode,
  refreshToken,
  getUser,
  listBoards,
  createBoard,
  createPin,
  uploadVideo,
  getPinAnalytics,
  getUserAnalytics
};
