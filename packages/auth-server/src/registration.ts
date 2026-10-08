import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { mailConfigured, sendMail, verificationCodeMail } from './mailer.js';
import { and, eq } from 'drizzle-orm';
import { normalizeEmail, registrationEmailVerificationEnabled } from '@mcp/shared';
import { db } from './db.js';
import { mcpServers, signupEmailCodes, userServerAccess, users } from './schema.js';
import { scryptHash } from './users.js';

export function validateSignup(
  username: string,
  email: string,
  password: string,
  confirmation: string,
): 'invalidUsername' | 'invalidEmail' | 'invalidPassword' | 'passwordMismatch' | null {
  // The email address is the account name; legacy username inputs are ignored.
  if (!normalizeEmail(email)) return 'invalidEmail';
  if (password.length < 12 || password.length > 256) return 'invalidPassword';
  if (password !== confirmation) return 'passwordMismatch';
  return null;
}

export type RegisteredUser = { id: number; username: string; role: 'admin' | 'user'; authVersion: number };
export type RegistrationResult =
  | { status: 'created'; user: RegisteredUser }
  | { status: 'username_taken' | 'email_taken' | 'invalid_verification_code' | 'verification_unavailable' };

/** Account creation and administrator-selected signup grants succeed together. */
export async function createRegisteredUser(
  username: string,
  email: string,
  password: string,
  verificationCode = '',
): Promise<RegistrationResult> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('createRegisteredUser requires a validated email address');
  username = normalizedEmail;
  const verifyEmail = registrationEmailVerificationEnabled();
  if (verifyEmail && !mailConfigured()) return { status: 'verification_unavailable' };
  const passwordHash = scryptHash(password);
  const now = Date.now();
  return db.transaction(async (tx) => {
    if (verifyEmail) {
      const [challenge] = await tx
        .select()
        .from(signupEmailCodes)
        .where(eq(signupEmailCodes.email, normalizedEmail))
        .for('update')
        .limit(1);
      if (!challenge || challenge.expiresAt <= Date.now() || !matchesSignupCode(verificationCode, challenge.codeHash))
        return { status: 'invalid_verification_code' };
    }

    const conflicts = await tx
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (conflicts.length) return { status: 'username_taken' };
    const [emailOwner] = await tx.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (emailOwner) return { status: 'email_taken' };
    const [user] = await tx
      .insert(users)
      .values({
        username,
        email: normalizedEmail,
        emailVerified: verifyEmail,
        passwordHash,
        role: 'user',
        disabled: false,
        allServers: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: users.id, username: users.username, role: users.role, authVersion: users.authVersion });
    if (!user) return { status: 'username_taken' };
    const defaults = await tx
      .select({ name: mcpServers.name })
      .from(mcpServers)
      .where(and(eq(mcpServers.enabled, true), eq(mcpServers.signupAccess, true)));
    if (defaults.length)
      await tx.insert(userServerAccess).values(
        defaults.map((server) => ({
          userId: user.id,
          serverName: server.name,
          createdAt: now,
        })),
      );
    if (verifyEmail) await tx.delete(signupEmailCodes).where(eq(signupEmailCodes.email, normalizedEmail));
    return { status: 'created', user };
  });
}

export function hashSignupCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
export function matchesSignupCode(code: string, hash: string): boolean {
  return (
    /^\d{6}$/.test(code) &&
    /^[a-f0-9]{64}$/.test(hash) &&
    timingSafeEqual(Buffer.from(hashSignupCode(code), 'hex'), Buffer.from(hash, 'hex'))
  );
}
export async function sendSignupEmailCode(
  email: string,
): Promise<'sent' | 'invalid_email' | 'verification_unavailable' | 'rate_limit_exceeded'> {
  const { consumeRateLimit } = await import('./rate-limit.js');
  const normalized = normalizeEmail(email);
  if (!normalized) return 'invalid_email';
  if (!mailConfigured()) return 'verification_unavailable';
  if (
    !(await consumeRateLimit('signup-code-cooldown', normalized, 1, 60)) ||
    !(await consumeRateLimit('signup-code-send', normalized, 5, 3600))
  )
    return 'rate_limit_exceeded';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  await db
    .insert(signupEmailCodes)
    .values({ email: normalized, codeHash: hashSignupCode(code), expiresAt: now + 600000, createdAt: now })
    .onConflictDoUpdate({
      target: signupEmailCodes.email,
      set: { codeHash: hashSignupCode(code), expiresAt: now + 600000, createdAt: now },
    });
  const mail = verificationCodeMail(code);
  await sendMail(normalized, mail.subject, mail.text);
  return 'sent';
}
