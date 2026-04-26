export function normalizeBackendUrl(value) {
  const fallback = 'http://localhost:9000';
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
}

export function buildApiUrl(baseUrl, pathname) {
  return new URL(pathname, normalizeBackendUrl(baseUrl)).toString();
}

export function buildWsUrl(baseUrl) {
  const backend = new URL(normalizeBackendUrl(baseUrl));
  backend.protocol = backend.protocol === 'https:' ? 'wss:' : 'ws:';
  backend.pathname = '/v1/ws';
  backend.search = '';
  backend.hash = '';
  return backend.toString();
}

export function buildHeaders(apiKey) {
  const headers = { 'content-type': 'application/json' };
  const key = String(apiKey || '').trim();
  if (key) {
    headers['x-api-key'] = key;
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

export async function requestJson(baseUrl, pathname, { method = 'GET', body, apiKey } = {}) {
  const response = await fetch(buildApiUrl(baseUrl, pathname), {
    method,
    headers: buildHeaders(apiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.code || response.statusText || 'request_failed');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function slugifyParticipantId(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'guest';
}