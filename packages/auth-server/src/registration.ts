import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import { mcpServers, userServerAccess, users } from './schema.js';
import { scryptHash } from './users.js';

export function validateSignup(
  username: string,
  password: string,
  confirmation: string,
): 'invalidUsername' | 'invalidPassword' | 'passwordMismatch' | null {
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username)) return 'invalidUsername';
  if (password.length < 12 || password.length > 256) return 'invalidPassword';
  if (password !== confirmation) return 'passwordMismatch';
  return null;
}

/** Account creation and administrator-selected signup grants succeed together. */
export async function createRegisteredUser(
  username: string,
  password: string,
): Promise<{ id: number; username: string; role: 'admin' | 'user'; authVersion: number } | null> {
  const passwordHash = scryptHash(password);
  const now = Date.now();
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username,
        passwordHash,
        role: 'user',
        disabled: false,
        allServers: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: users.username })
      .returning({ id: users.id, username: users.username, role: users.role, authVersion: users.authVersion });
    if (!user) return null;
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
    return user;
  });
}
