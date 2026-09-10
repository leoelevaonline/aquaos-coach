// Run inside the API container via node --input-type=module < this file.
// Uses existing environment credentials without printing them or response data.
// Creates temporary login sessions, calls the configured AI once, logs out.
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import pg from 'pg';

let failures = 0;
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) {
    failures++;
    // No response bodies, URLs containing credentials, cookies, or secrets.
    console.log(`FAIL ${name}: ${error.code ?? error.name ?? 'Error'}`);
  }
}
const base = process.env.APP_BASE_URL;
assert.ok(base?.startsWith('https://'), 'APP_BASE_URL must be HTTPS');
async function request(path, expected = 200, cookie = '', body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (response.status !== expected) throw Object.assign(new Error(), { code: `HTTP_${response.status}_EXPECTED_${expected}` });
  return response;
}

await check('DNS postgres', () => lookup('postgres'));
await check('DNS configured LLM gateway', () => lookup(new URL(process.env.LLM_BASE_URL).hostname));
await check('Live PostgreSQL query', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  try { await client.connect(); assert.equal((await client.query('SELECT 1 AS ok')).rows[0].ok, 1); }
  finally { await client.end(); }
});
for (const path of ['/', '/pt/coach/today', '/pt/coach/athletes', '/pt/coach/practices', '/pt/coach/rkf', '/pt/coach/analytics', '/pt/coach/seasons', '/pt/coach/videos', '/pt/coach/perfect-race', '/pt/coach/protocols', '/pt/coach/assistant', '/pt/coach/inbox', '/pt/athlete/home', '/manifest.webmanifest']) {
  await check(`HTTPS ${path}`, async () => { const r = await request(path); await r.arrayBuffer(); });
}
await check('API persistence health', async () => {
  const data = await (await request('/api/v1/health')).json();
  assert.equal(data.ok, true); assert.equal(data.persistence.driver, 'postgres'); assert.equal(data.persistence.connected, true);
});
await check('Anonymous access denied', () => request('/api/v1/manage', 401));
await check('Production demo accounts disabled', () => request('/api/v1/auth/demo-accounts', 404));
for (const role of ['coach', 'athlete']) {
  let cookie = '';
  let athleteId;
  await check(`${role}: login, secure cookie, session`, async () => {
    const prefix = `AUTH_${role.toUpperCase()}`;
    assert.ok(process.env[`${prefix}_PASSWORD`]);
    const response = await request('/api/v1/auth/login', 200, '', {
      email: process.env[`${prefix}_EMAIL`], password: process.env[`${prefix}_PASSWORD`],
    });
    const header = response.headers.get('set-cookie');
    cookie = header?.split(';')[0] ?? '';
    assert.ok(header?.includes('HttpOnly') && header.includes('Secure') && header.includes('SameSite=Lax'));
    const session = await (await request('/api/v1/auth/me', 200, cookie)).json();
    assert.equal(session.user.role, role); athleteId = session.user.athleteId;
  });
  try {
    if (!cookie) continue;
    if (role === 'coach') {
      for (const path of ['/api/v1/dashboard', '/api/v1/athletes', '/api/v1/groups', '/api/v1/workouts', '/api/v1/analytics/overview', '/api/v1/manage', '/api/v1/manage/videos', '/api/v1/manage/documents', '/api/v1/rkf/sessions', '/api/v1/rkf/migrations']) {
        await check(`coach: ${path}`, async () => { await (await request(path, 200, cookie)).json(); });
      }
      await check('AI gateway/model availability', async () => {
        const data = await (await request('/api/v1/ai/status', 200, cookie)).json();
        assert.equal(data.available, true);
      });
      for (const kind of ['racePlans', 'protocols', 'staffAssessments', 'readinessScores', 'macrocycles', 'mesocycles', 'microcycles', 'loadSnapshots']) {
        await check(`coach: managed ${kind}`, async () => {
          const data = await (await request(`/api/v1/manage/${kind}`, 200, cookie)).json();
          assert.ok(Array.isArray(data.data));
        });
      }
      await check('AI configured model returns an answer (synthetic data only)', async () => {
        const response = await fetch(`${process.env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.LLM_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: process.env.LLM_MODEL, messages: [{ role: 'user', content: 'Connectivity test. Reply only OK.' }], max_tokens: 64, stream: false }),
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) throw Object.assign(new Error(), { code: `LLM_HTTP_${response.status}` });
        const data = await response.json();
        assert.ok(data.choices?.[0]?.message?.content?.trim()?.length > 0);
      });
    } else {
      await check('athlete cannot access coach management', () => request('/api/v1/manage', 403, cookie));
      await check('athlete own results', () => request(`/api/v1/rkf/results/athletes/${encodeURIComponent(athleteId)}`, 200, cookie));
      await check('athlete cannot access another athlete', () => request('/api/v1/rkf/results/athletes/another-athlete-smoke', 403, cookie));
    }
  } finally {
    if (cookie) {
      await check(`${role}: logout`, () => request('/api/v1/auth/logout', 200, cookie, {}));
      await check(`${role}: revoked session rejected`, () => request('/api/v1/auth/me', 401, cookie));
    }
  }
}
console.log(`Failures: ${failures}`);
process.exitCode = failures ? 1 : 0;
