import { and, eq } from 'drizzle-orm';
import { db } from '../../infrastructure/database/client.js';
import { LockNamespace, lockTransaction } from '../../infrastructure/database/locks.js';
import {
  mcpServers,
  oauthConnectionStates,
  userMcpCredentials,
  userServerAccess,
  users,
} from '../../infrastructure/database/schema.js';

export type ConnectionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockConnectionServer(tx: ConnectionTransaction, userId: number, serverName: string) {
  const [server] = await tx.select().from(mcpServers).where(eq(mcpServers.name, serverName)).for('share').limit(1);
  if (!server) return null;
  // A connection can have no credential row yet, so row locking alone is insufficient.
  await lockTransaction(tx, LockNamespace.LegacyConnection, `${userId}:${serverName}`);
  return server;
}

/** Always lock the parent server before state/credentials, including during a refresh. */
export async function lockAccessibleConnection(
  tx: ConnectionTransaction,
  userId: number,
  serverName: string,
  expectedRevision?: number,
  expectedAuthVersion?: number,
) {
  const server = await lockConnectionServer(tx, userId, serverName);
  if (!server || !server.enabled || (expectedRevision !== undefined && server.authRevision !== expectedRevision))
    return null;
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('share').limit(1);
  if (!user || user.disabled || (expectedAuthVersion !== undefined && user.authVersion !== expectedAuthVersion))
    return null;
  if (user.role !== 'admin' && !user.allServers) {
    const [grant] = await tx
      .select({ userId: userServerAccess.userId })
      .from(userServerAccess)
      .where(and(eq(userServerAccess.userId, userId), eq(userServerAccess.serverName, serverName)))
      .for('share')
      .limit(1);
    if (!grant) return null;
  }
  return server;
}

/** Pending callbacks stay cancellable while the provider's token request is in flight. */
export async function revokeUserConnection(userId: number, serverName: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const server = await lockConnectionServer(tx, userId, serverName);
    if (!server) return false;
    const states = await tx
      .delete(oauthConnectionStates)
      .where(and(eq(oauthConnectionStates.userId, userId), eq(oauthConnectionStates.serverName, serverName)))
      .returning({ state: oauthConnectionStates.state });
    const credentials = await tx
      .delete(userMcpCredentials)
      .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, serverName)))
      .returning({ userId: userMcpCredentials.userId });
    return states.length > 0 || credentials.length > 0;
  });
}
