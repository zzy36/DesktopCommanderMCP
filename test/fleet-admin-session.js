import assert from 'node:assert/strict';
export async function adminSession(origin, secret) {
  const page = await fetch(origin + '/admin/login');
  const html = await page.text();
  const nonce = html.match(/name="nonce" value="([^"]+)"/)[1];
  const loginCookie = page.headers.get('set-cookie').split(';')[0];
  const login = await fetch(origin + '/admin/login', { method: 'POST', redirect: 'manual', headers: { origin, cookie: loginCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret, nonce }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(origin + '/admin/api/session', { headers: { cookie } });
  assert.equal(response.status, 200);
  const { csrf } = await response.json();
  return { cookie, csrf, headers: { cookie, origin, 'x-lcm-csrf': csrf } };
}
