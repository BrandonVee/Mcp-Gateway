import { eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { userServerAccess, users } from '@/auth/infrastructure/database/schema.js';

export async function listServerNamesForUser(userId: number): Promise<string[]> {
  const rows = await db
    .select({ serverName: userServerAccess.serverName })
    .from(userServerAccess)
    .where(eq(userServerAccess.userId, userId))
    .orderBy(userServerAccess.serverName);
  return rows.map((row) => row.serverName);
}

export async function replaceUserServers(userId: number, names: string[]): Promise<void> {
  const unique = [...new Set(names)];
  const allServers = unique.includes('*');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ allServers, updatedAt: Date.now() }).where(eq(users.id, userId));
    await tx.delete(userServerAccess).where(eq(userServerAccess.userId, userId));
    for (const name of allServers ? [] : unique) {
      await tx.insert(userServerAccess).values({ userId, serverName: name, createdAt: Date.now() });
    }
  });
}
