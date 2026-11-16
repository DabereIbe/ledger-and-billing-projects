const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

// Access token lives in memory only: XSS can't read it from storage, and a page reload simply
// re-acquires one through the httpOnly refresh cookie (see restoreSession).
let accessToken = null;

// ONE shared in-flight refresh. The API rotates refresh tokens and treats reuse as theft, so two
// concurrent refreshes would log the user out. Every caller awaits the same promise instead.
let refreshing = null;
function refresh() {
  refreshing ??= fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (r) => { if (!r.ok) throw new Error('no session'); accessToken = (await r.json()).accessToken; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(path, { method = 'GET', body } = {}, canRetry = true) {
  const res = await fetch(`${BASE}${path}`, {
    method, credentials: 'include',   // required for the cross-origin refresh cookie
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(accessToken && { Authorization: `Bearer ${accessToken}` }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401 && canRetry && !path.startsWith('/auth/')) {   // access token expired: refresh once, retry once
    await refresh();
    return api(path, { method, body }, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data;
}

export const restoreSession = async () => { await refresh(); return api('/auth/me'); };
export const login = async (email, password) => {
  accessToken = (await api('/auth/login', { method: 'POST', body: { email, password } })).accessToken;
  return api('/auth/me');
};
export const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); accessToken = null; };
