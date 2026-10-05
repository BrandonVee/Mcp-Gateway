import { and, eq } from 'drizzle-orm';
import { normalizeEmail } from '@mcp/shared';
import { db } from './db.js';
import { mcpServers, userServerAccess, users } from './schema.js';
import { scryptHash } from './users.js';

export function validateSignup(
  username: string,
  email: string,
  password: string,
  confirmation: string,
): 'invalidUsername' | 'invalidEmail' | 'invalidPassword' | 'passwordMismatch' | null {
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username)) return 'invalidUsername';
  if (!normalizeEmail(email)) return 'invalidEmail';
  if (password.length < 12 || password.length > 256) return 'invalidPassword';
  if (password !== confirmation) return 'passwordMismatch';
  return null;
}

export type RegisteredUser = { id: number; username: string; role: 'admin' | 'user'; authVersion: number };
export type RegistrationResult =
  { status: 'created'; user: RegisteredUser } | { status: 'username_taken' | 'email_taken' };

/** Account creation and administrator-selected signup grants succeed together. */
export async function createRegisteredUser(
  username: string,
  email: string,
  password: string,
): Promise<RegistrationResult> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('createRegisteredUser requires a validated email address');
  const passwordHash = scryptHash(password);
  const now = Date.now();
  return db.transaction(async (tx) => {
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
        emailVerified: false,
        passwordHash,
        role: 'user',
        disabled: false,
        allServers: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: users.username })
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
    return { status: 'created', user };
  });
}
