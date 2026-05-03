const GOOGLE_DOC_ID_RE = /^[A-Za-z0-9_-]{20,}$/;

export const GOOGLE_DOCS_EXPORT_MIME_TYPE = 'text/markdown';
export const GOOGLE_OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function googleError(message, extra = {}) {
  const err = new Error(message);
  Object.assign(err, extra);
  return err;
}

export function normalizeGoogleDocId(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const pathMatch = url.pathname.match(/\/document\/d\/([A-Za-z0-9_-]{20,})/);
    if (pathMatch) return pathMatch[1];
    const queryId = url.searchParams.get('id');
    if (queryId && GOOGLE_DOC_ID_RE.test(queryId)) return queryId;
  } catch {
    // Bare ID is handled below.
  }

  if (GOOGLE_DOC_ID_RE.test(raw)) return raw;
  return null;
}

export function buildGoogleOAuthUrl({ clientId, redirectUri, state }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

async function parseGoogleResponseError(res) {
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const details = payload?.error_description || payload?.error?.message || payload?.error || `HTTP ${res.status}`;
  return googleError(`Google API error: ${details}`, {
    status: res.status,
    google_error: payload?.error || null,
  });
}

export async function exchangeGoogleAuthCode({ clientId, clientSecret, redirectUri, code }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw await parseGoogleResponseError(res);
  return res.json();
}

export async function refreshGoogleAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw await parseGoogleResponseError(res);
  return res.json();
}

export async function exportGoogleDocAsMarkdown({ accessToken, docId }) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export`);
  url.searchParams.set('mimeType', GOOGLE_DOCS_EXPORT_MIME_TYPE);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await parseGoogleResponseError(res);
  return res.text();
}
