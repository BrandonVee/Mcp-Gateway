import assert from 'node:assert/strict';
import test from 'node:test';
import { trustedAdminBearerClient } from '@/auth/shared/security/admin-bearer.js';

test('production admin API rejects OAuth bearer clients unless explicitly trusted', () => {
  const production = { NODE_ENV: 'production', ADMIN_BEARER_CLIENT_IDS: 'trusted-admin-client' };
  assert.equal(trustedAdminBearerClient('trusted-admin-client', production), true);
  assert.equal(trustedAdminBearerClient('new-dynamic-client', production), false);
  assert.equal(trustedAdminBearerClient(undefined, production), false);
  assert.equal(trustedAdminBearerClient('trusted-admin-client', { NODE_ENV: 'production' }), false);
});
