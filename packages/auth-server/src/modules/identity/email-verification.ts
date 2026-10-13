import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../../infrastructure/database/client.js';
import { emailVerificationCodes, users } from '../../infrastructure/database/schema.js';
import { mailConfigured, sendMail, verificationCodeMail } from '../../infrastructure/mail/mailer.js';
import { generateVerificationCode, hashVerificationCode } from '../../infrastructure/security/verification-code.js';

const CODE_TTL_MS = 10 * 60 * 1000;

function hashCode(code: string): string {
  return hashVerificationCode(code);
}

/**
 * Issues a fresh six-digit code for the user's current email address. Each
 * resend replaces the previous code, so only the newest message can verify.
 */
export async function sendEmailVerificationCode(userId: number): Promise<'sent' | 'no_email' | 'not_configured'> {
  const [user] = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.email) return 'no_email';
  if (!mailConfigured()) return 'not_configured';
  const code = generateVerificationCode();
  const now = Date.now();
  await db
    .insert(emailVerificationCodes)
    .values({ userId, email: user.email, codeHash: hashCode(code), expiresAt: now + CODE_TTL_MS, createdAt: now })
    .onConflictDoUpdate({
      target: emailVerificationCodes.userId,
      set: { email: user.email, codeHash: hashCode(code), expiresAt: now + CODE_TTL_MS, createdAt: now },
    });
  const mail = verificationCodeMail(code);
  await sendMail(user.email, mail.subject, mail.text);
  return 'sent';
}

/** Marks the account email verified when the submitted code matches and is fresh. */
export async function verifyEmailCode(userId: number, code: string): Promise<'verified' | 'invalid'> {
  const [row] = await db
    .select()
    .from(emailVerificationCodes)
    .where(eq(emailVerificationCodes.userId, userId))
    .limit(1);
  if (!row || row.expiresAt < Date.now()) return 'invalid';
  const submitted = Buffer.from(hashCode(code), 'hex');
  const expected = Buffer.from(row.codeHash, 'hex');
  if (!timingSafeEqual(submitted, expected)) return 'invalid';
  await db.transaction(async (tx) => {
    await tx.delete(emailVerificationCodes).where(eq(emailVerificationCodes.userId, userId));
    await tx.update(users).set({ emailVerified: true, updatedAt: Date.now() }).where(eq(users.id, userId));
  });
  return 'verified';
}
