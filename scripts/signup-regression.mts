/** Run against a disposable mcp_signup_test_* database only. */
import assert from 'node:assert/strict';
import { applySystemSettings } from '../packages/shared/src/index.js';
import { createRegisteredUser, hashSignupCode } from '../packages/auth-server/src/registration.js';
import { db, initializeDatabase, pool, verifyUser } from '../packages/auth-server/src/db.js';
import { signupEmailCodes, users } from '../packages/auth-server/src/schema.js';
import { scryptHash } from '../packages/auth-server/src/users.js';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/invalid');
assert.match(url.pathname, /^\/mcp_signup_test_[a-z0-9_]+$/, 'Use an isolated regression database');
const password = 'a-safe-test-password';
const base = { public_url: 'https://mcp.example.test', upstream_allowlist_enabled: true, upstream_hosts: [] };
try {
  await initializeDatabase();
  applySystemSettings({ ...base, registration_email_verification: false });
  const created = await createRegisteredUser('ignored', ' Alice@Example.test ', password);
  assert.equal(created.status, 'created');
  if (created.status !== 'created') throw new Error('not created');
  assert.equal(created.user.username, 'alice@example.test');
  assert.equal((await verifyUser('ALICE@example.test', password))?.id, created.user.id);
  assert.equal((await db.select().from(users))[0].emailVerified, false);
  assert.equal((await createRegisteredUser('another', 'alice@example.test', password)).status, 'username_taken');
  const now = Date.now();
  await db.insert(users).values({
    username: 'legacy',
    email: 'legacy@example.test',
    passwordHash: scryptHash(password),
    role: 'user',
    createdAt: now,
    updatedAt: now,
  });
  assert.equal((await verifyUser('legacy', password))?.username, 'legacy');
  assert.equal((await verifyUser('LEGACY@example.test', password))?.username, 'legacy');
  applySystemSettings({ ...base, registration_email_verification: true });
  assert.equal(
    (await createRegisteredUser('', 'new@example.test', password, '123456')).status,
    'verification_unavailable',
  );
  applySystemSettings({
    ...base,
    registration_email_verification: true,
    smtp_host: 'smtp.example.test',
    smtp_from: 'sender@example.test',
  });
  assert.equal((await createRegisteredUser('', 'new@example.test', password)).status, 'invalid_verification_code');
  await db
    .insert(signupEmailCodes)
    .values({ email: 'new@example.test', codeHash: hashSignupCode('123456'), expiresAt: now + 600000, createdAt: now });
  assert.equal(
    (await createRegisteredUser('', 'other@example.test', password, '123456')).status,
    'invalid_verification_code',
  );
  assert.equal(
    (await createRegisteredUser('', 'new@example.test', password, '999999')).status,
    'invalid_verification_code',
  );
  assert.equal(
    (await createRegisteredUser('', 'new@example.test', password, '<script>')).status,
    'invalid_verification_code',
  );
  assert.equal((await db.select().from(signupEmailCodes)).length, 1, 'Invalid attempts do not consume a valid code');
  const results = await Promise.all([
    createRegisteredUser('', 'new@example.test', password, '123456'),
    createRegisteredUser('', 'new@example.test', password, '123456'),
  ]);
  assert.equal(results.filter((result) => result.status === 'created').length, 1);
  assert.equal((await db.select().from(signupEmailCodes)).length, 0, 'Successful code consumed exactly once');
  assert.equal(
    (await createRegisteredUser('', 'new@example.test', password, '123456')).status,
    'invalid_verification_code',
  );
  const rows = await db.select().from(users);
  assert.equal(rows.find((row) => row.email === 'new@example.test')?.emailVerified, true);
  await db.insert(signupEmailCodes).values({
    email: 'expired@example.test',
    codeHash: hashSignupCode('123456'),
    expiresAt: Date.now() - 1,
    createdAt: now,
  });
  assert.equal(
    (await createRegisteredUser('', 'expired@example.test', password, '123456')).status,
    'invalid_verification_code',
  );
  console.log(
    'Signup regression passed: email identity, legacy login, optional verification, invalid/expired/email-bound codes, atomic consumption and concurrency.',
  );
} finally {
  await pool.end();
}
