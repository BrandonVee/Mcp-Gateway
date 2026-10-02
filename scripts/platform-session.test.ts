import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, apiForSession, ApiError } from '../packages/admin-web/src/api';
import type { PlatformSession } from '../packages/admin-web/src/types';

test('page API callbacks retain their original identity after another account signs in', async (t) => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const first: PlatformSession = { authenticated: true, user_id: 7, auth_version: 2, username: 'alice', role: 'user' };
  const oldPage = apiForSession(first);
  // Reused usernames still differ by immutable user ID and credential revision.
  const newPage = apiForSession({ ...first, user_id: 8, auth_version: 0 });
  await newPage.saveApiKey('service', 'new-key');
  await oldPage.saveApiKey('service', 'old-key');
  await oldPage.myLogout();
  await oldPage.updateUser(9, { disabled: true });
  assert.deepEqual(sent.map(({ init }) => new Headers(init.headers).get('x-session-identity')), ['8:0', '7:2', '7:2', '7:2']);
  assert.ok(sent.every(({ init }) => init.credentials === 'include'));
  await oldPage.mySession();
  await oldPage.myLogin('bob', 'existing-password');
  await api.myLogin('bob', 'existing-password');
  assert.ok(sent.slice(4).every(({ init }) => !new Headers(init.headers).has('x-session-identity')),
    'read-only session checks and a new sign-in must remain independent of an old identity');
});

test('session-change errors preserve their code for identity revalidation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'session_changed' }), { status: 409 }));
  await assert.rejects(api.myLogout(), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'session_changed');
});
