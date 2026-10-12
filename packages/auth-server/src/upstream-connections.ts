import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { authIssuer, adminWebUrl } from '@mcp/shared';
import { db, type AuthTransaction } from './db.js';
import { currentUser, internalTokenMatches } from './connections.js';
import { encryptCredential, decryptCredential } from './credential-crypto.js';
import {
  mcpServers,
  mcpServerInstances,
  upstreamCredentials,
  upstreamOAuthStates,
  userMcpCredentials,
  users,
  userServerAccess,
} from './schema.js';
import {
  exchangeOAuthToken,
  tokenExpiry,
  shouldRefresh,
  accessTokenValid,
  OAuthTokenError,
} from './oauth-token-exchange.js';

type Identity = { id: number; authVersion: number; role: 'admin' | 'user' };

/** Parent -> upstream -> user -> grant -> credential: the common lock order. */
export async function lockUpstream(tx: AuthTransaction, id: string, user: Identity, revision?: number) {
  const [lookup] = await tx
    .select({ parent: mcpServerInstances.serverName })
    .from(mcpServerInstances)
    .where(eq(mcpServerInstances.id, id));
  if (!lookup) return null;
  const [parent] = await tx.select().from(mcpServers).where(eq(mcpServers.name, lookup.parent)).for('share');
  const [upstream] = await tx.select().from(mcpServerInstances).where(eq(mcpServerInstances.id, id)).for('share');
  if (
    !parent?.enabled ||
    !upstream?.enabled ||
    upstream.serverName !== parent.name ||
    (revision !== undefined && upstream.authRevision !== revision)
  )
    return null;
  const [account] = await tx.select().from(users).where(eq(users.id, user.id)).for('share');
  if (!account || account.disabled || account.authVersion !== user.authVersion) return null;
  if (account.role !== 'admin' && !account.allServers) {
    const [grant] = await tx
      .select()
      .from(userServerAccess)
      .where(and(eq(userServerAccess.userId, user.id), eq(userServerAccess.serverName, parent.name)))
      .for('share');
    if (!grant) return null;
  }
  return { upstream, parent, account };
}

const ownerFor = (system: boolean, userId: number) => (system ? 'system' : `user:${userId}`);
const callback = (id: string) => `${authIssuer()}/oauth/upstream-callback/${encodeURIComponent(id)}`;
const portal = (result: string, id: string) => {
  const url = new URL('/connections', adminWebUrl());
  url.searchParams.set('result', result);
  url.searchParams.set('server', id);
  return url.toString();
};

async function lockOwner(tx: AuthTransaction, id: string, owner: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(80448, hashtext(${`${id}:${owner}`}))`);
}

export async function resolveUpstreamCredential(
  id: string,
  identity: Identity,
  endpoint?: string,
  expectedUrl?: string,
) {
  return db.transaction(async (tx) => {
    const locked = await lockUpstream(tx, id, identity);
    if (!locked || (endpoint !== undefined && locked.parent.name !== endpoint)) return { denied: true as const };
    const s = locked.upstream;
    if (expectedUrl !== undefined && s.url !== expectedUrl) return { configChanged: true as const };
    if (s.authMode === 'none') return { credential: null, revision: s.authRevision };
    if (s.authMode === 'system_api_key')
      return s.systemApiKey
        ? {
            credential: { header: s.apiKeyHeader, value: s.apiKeyPrefix + decryptCredential(s.systemApiKey) },
            revision: s.authRevision,
          }
        : { missing: true as const, system: true };
    const system = s.authMode === 'system_oauth';
    const owner = ownerFor(system, identity.id);
    await lockOwner(tx, id, owner);
    const [row] = await tx
      .select()
      .from(upstreamCredentials)
      .where(and(eq(upstreamCredentials.instanceId, id), eq(upstreamCredentials.owner, owner)))
      .for('update');
    const mode = s.authMode === 'api_key' ? 'api_key' : 'oauth';
    if (!row || row.mode !== mode) return { missing: true as const, system };
    if (mode === 'api_key')
      return {
        credential: { header: s.apiKeyHeader, value: s.apiKeyPrefix + decryptCredential(row.secret) },
        revision: s.authRevision,
      };
    if (shouldRefresh(row.expiresAt, Boolean(row.refreshSecret))) {
      try {
        const body = await exchangeOAuthToken(
          s,
          new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptCredential(row.refreshSecret!) }),
        );
        const values = {
          secret: encryptCredential(body.access_token),
          refreshSecret:
            typeof body.refresh_token === 'string' && body.refresh_token
              ? encryptCredential(body.refresh_token)
              : row.refreshSecret,
          expiresAt: tokenExpiry(body),
          updatedAt: Date.now(),
        };
        await tx
          .update(upstreamCredentials)
          .set(values)
          .where(and(eq(upstreamCredentials.instanceId, id), eq(upstreamCredentials.owner, owner)));
        return {
          credential: { header: 'authorization', value: `Bearer ${body.access_token}` },
          revision: s.authRevision,
        };
      } catch (error) {
        if (error instanceof OAuthTokenError && error.permanent) {
          await tx
            .update(upstreamCredentials)
            .set({ refreshSecret: null })
            .where(and(eq(upstreamCredentials.instanceId, id), eq(upstreamCredentials.owner, owner)));
        }
        if (!accessTokenValid(row.expiresAt)) return { missing: true as const, system };
      }
    }
    return accessTokenValid(row.expiresAt)
      ? {
          credential: { header: 'authorization', value: `Bearer ${decryptCredential(row.secret)}` },
          revision: s.authRevision,
        }
      : { missing: true as const, system };
  });
}

export function createUpstreamConnectionsRouter() {
  const router = new Hono();
  router.get('/me/upstreams', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const parents = await db.select().from(mcpServers).where(eq(mcpServers.enabled, true));
    const grants = await db.select().from(userServerAccess).where(eq(userServerAccess.userId, user.id));
    const allowed = new Set(
      parents
        .filter((p) => user.role === 'admin' || user.allServers || grants.some((g) => g.serverName === p.name))
        .map((p) => p.name),
    );
    const instances = await db.select().from(mcpServerInstances).where(eq(mcpServerInstances.enabled, true));
    const rows = await db
      .select({
        instanceId: upstreamCredentials.instanceId,
        owner: upstreamCredentials.owner,
        mode: upstreamCredentials.mode,
        expiresAt: upstreamCredentials.expiresAt,
        refreshSecret: upstreamCredentials.refreshSecret,
      })
      .from(upstreamCredentials);
    const legacy = await db.select().from(userMcpCredentials).where(eq(userMcpCredentials.userId, user.id));
    return c.json({
      servers: instances
        .filter(
          (s) => allowed.has(s.serverName) && parents.find((p) => p.name === s.serverName)?.routingMode === 'aggregate',
        )
        .map((s) => {
          const system = s.authMode === 'system_oauth';
          const row = rows.find((r) => r.instanceId === s.id && r.owner === ownerFor(system, user.id));
          const mode = s.authMode === 'api_key' ? 'api_key' : 'oauth';
          const status =
            s.authMode === 'none' || s.authMode === 'system_api_key'
              ? 'not_required'
              : !row || row.mode !== mode
                ? 'not_connected'
                : !accessTokenValid(row.expiresAt) && !row.refreshSecret
                  ? 'expired'
                  : 'connected';
          const parent = parents.find((p) => p.name === s.serverName)!;
          return {
            name: s.id,
            endpoint_name: parent.name,
            endpoint_display_name: parent.displayName,
            display_name: s.displayName || s.id,
            description: parent.description,
            auth_mode: s.authMode,
            connection_status: status,
          };
        })
        .concat(
          parents
            .filter((p) => p.routingMode === 'pool' && allowed.has(p.name))
            .map((p) => {
              const row = legacy.find((r) => r.serverName === p.name);
              return {
                name: `endpoint:${p.name}`,
                endpoint_name: p.name,
                endpoint_display_name: p.displayName,
                display_name: p.displayName,
                description: p.description,
                auth_mode: p.authMode,
                connection_status:
                  p.authMode === 'none' || p.authMode === 'system_api_key'
                    ? 'not_required'
                    : !row || row.mode !== p.authMode
                      ? 'not_connected'
                      : !accessTokenValid(row.expiresAt) && !row.refreshSecret
                        ? 'expired'
                        : 'connected',
              };
            }),
        ),
    });
  });

  router.put('/me/upstreams/:id/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const key = (await c.req.json().catch(() => ({}))).api_key;
    if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\x00-\x1f\x7f]/.test(key))
      return c.json({ error: 'invalid_api_key' }, 400);
    const saved = await db.transaction(async (tx) => {
      const locked = await lockUpstream(tx, c.req.param('id'), user);
      if (!locked || locked.upstream.authMode !== 'api_key') return false;
      const id = locked.upstream.id,
        owner = ownerFor(false, user.id);
      await lockOwner(tx, id, owner);
      const values = {
        userId: user.id,
        mode: 'api_key' as const,
        secret: encryptCredential(key),
        refreshSecret: null,
        expiresAt: null,
        updatedAt: Date.now(),
      };
      await tx
        .insert(upstreamCredentials)
        .values({ instanceId: id, owner, ...values })
        .onConflictDoUpdate({ target: [upstreamCredentials.instanceId, upstreamCredentials.owner], set: values });
      return true;
    });
    return saved ? c.json({ connection_status: 'connected' }) : c.json({ error: 'server_changed_or_denied' }, 409);
  });

  router.delete('/me/upstreams/:id/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const result = await db.transaction(async (tx) => {
      const locked = await lockUpstream(tx, c.req.param('id'), user);
      if (!locked) return false;
      const system = locked.upstream.authMode === 'system_oauth';
      if (system && user.role !== 'admin') return false;
      if (locked.upstream.authMode === 'system_api_key' || locked.upstream.authMode === 'none') return false;
      const owner = ownerFor(system, user.id);
      await lockOwner(tx, locked.upstream.id, owner);
      await tx
        .delete(upstreamCredentials)
        .where(and(eq(upstreamCredentials.instanceId, locked.upstream.id), eq(upstreamCredentials.owner, owner)));
      await tx
        .delete(upstreamOAuthStates)
        .where(
          and(
            eq(upstreamOAuthStates.instanceId, locked.upstream.id),
            eq(upstreamOAuthStates.system, system),
            ...(system ? [] : [eq(upstreamOAuthStates.userId, user.id)]),
          ),
        );
      return true;
    });
    return result
      ? c.json({ connection_status: 'not_connected' })
      : c.json({ error: 'server_not_found_or_denied' }, 403);
  });

  router.post('/me/upstreams/:id/oauth', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url');
    const target = await db.transaction(async (tx) => {
      const locked = await lockUpstream(tx, c.req.param('id'), user);
      if (!locked) return null;
      const s = locked.upstream,
        system = s.authMode === 'system_oauth';
      if (
        (s.authMode !== 'oauth' && !system) ||
        (system && user.role !== 'admin') ||
        !s.oauthAuthorizeUrl ||
        !s.oauthClientId
      )
        return null;
      await lockOwner(tx, s.id, ownerFor(system, user.id));
      await tx
        .delete(upstreamOAuthStates)
        .where(
          and(
            eq(upstreamOAuthStates.instanceId, s.id),
            eq(upstreamOAuthStates.system, system),
            ...(system ? [] : [eq(upstreamOAuthStates.userId, user.id)]),
          ),
        );
      await tx.insert(upstreamOAuthStates).values({
        state,
        instanceId: s.id,
        userId: user.id,
        system,
        verifier,
        authRevision: s.authRevision,
        expiresAt: Date.now() + 600_000,
      });
      return s;
    });
    if (!target) return c.json({ error: 'oauth_not_configured' }, 403);
    const url = new URL(target.oauthAuthorizeUrl!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', target.oauthClientId!);
    url.searchParams.set('redirect_uri', callback(target.id));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    if (target.oauthScopes) url.searchParams.set('scope', target.oauthScopes);
    if (target.oauthResource) url.searchParams.set('resource', target.oauthResource);
    return c.json({ authorization_url: url.toString() });
  });

  router.get('/oauth/upstream-callback/:id', async (c) => {
    const [state] = await db
      .select()
      .from(upstreamOAuthStates)
      .where(eq(upstreamOAuthStates.state, c.req.query('state') ?? ''));
    if (!state || state.instanceId !== c.req.param('id') || state.expiresAt <= Date.now())
      return c.redirect(portal('invalid_state', c.req.param('id')));
    const user = await currentUser(c);
    if (!user || user.id !== state.userId || (state.system && user.role !== 'admin'))
      return c.redirect(portal('session_expired', state.instanceId));
    const code = c.req.query('code');
    // Consume the state before exchanging, including on cancellation; replay cannot exchange twice.
    const target = await db.transaction(async (tx) => {
      const locked = await lockUpstream(tx, state.instanceId, user, state.authRevision);
      if (!locked) return null;
      const s = locked.upstream;
      if (
        s.authMode !== (state.system ? 'system_oauth' : 'oauth') ||
        (s.oauthIssuer && c.req.query('iss') !== s.oauthIssuer)
      )
        return null;
      const consumed = await tx
        .update(upstreamOAuthStates)
        .set({ exchanging: true })
        .where(and(eq(upstreamOAuthStates.state, state.state), eq(upstreamOAuthStates.exchanging, false)))
        .returning();
      return consumed.length ? s : null;
    });
    if (!target) return c.redirect(portal('invalid_state', state.instanceId));
    if (!code || c.req.query('error')) {
      await db.delete(upstreamOAuthStates).where(eq(upstreamOAuthStates.state, state.state));
      return c.redirect(portal('cancelled', state.instanceId));
    }
    const body = await exchangeOAuthToken(
      target,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback(target.id),
        code_verifier: state.verifier,
      }),
    ).catch(() => null);
    if (!body) {
      await db.delete(upstreamOAuthStates).where(eq(upstreamOAuthStates.state, state.state));
      return c.redirect(portal('token_error', state.instanceId));
    }
    const saved = await db.transaction(async (tx) => {
      const locked = await lockUpstream(tx, target.id, user, state.authRevision);
      if (!locked || locked.upstream.authMode !== target.authMode) return false;
      const owner = ownerFor(state.system, user.id);
      await lockOwner(tx, target.id, owner);
      const [pending] = await tx
        .select()
        .from(upstreamOAuthStates)
        .where(eq(upstreamOAuthStates.state, state.state))
        .for('update');
      if (!pending || !pending.exchanging || pending.expiresAt <= Date.now()) return false;
      await tx.delete(upstreamOAuthStates).where(eq(upstreamOAuthStates.state, state.state));
      const values = {
        userId: state.system ? null : user.id,
        mode: 'oauth' as const,
        secret: encryptCredential(body.access_token),
        refreshSecret:
          typeof body.refresh_token === 'string' && body.refresh_token ? encryptCredential(body.refresh_token) : null,
        expiresAt: tokenExpiry(body),
        updatedAt: Date.now(),
      };
      await tx
        .insert(upstreamCredentials)
        .values({ instanceId: target.id, owner, ...values })
        .onConflictDoUpdate({ target: [upstreamCredentials.instanceId, upstreamCredentials.owner], set: values });
      return true;
    });
    return c.redirect(portal(saved ? 'connected' : 'invalid_state', state.instanceId));
  });

  router.get('/internal/upstream-credential', async (c) => {
    if (!internalTokenMatches(c.req.header('authorization'))) return c.json({ error: 'invalid_internal_token' }, 401);
    c.header('Cache-Control', 'no-store');
    const id = Number(c.req.query('user_id')),
      version = Number(c.req.query('auth_version'));
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !/^\d+$/.test(c.req.query('auth_version') ?? '') ||
      !Number.isSafeInteger(version)
    )
      return c.json({ error: 'invalid_user' }, 400);
    const result = await resolveUpstreamCredential(
      c.req.query('instance_id') ?? '',
      { id, authVersion: version, role: 'user' },
      c.req.query('endpoint') ?? '',
      c.req.query('upstream_url') ?? '',
    );
    if ('configChanged' in result) return c.json({ error: 'upstream_config_changed' }, 503);
    if ('denied' in result) return c.json({ error: 'access_denied' }, 403);
    if ('missing' in result)
      return c.json(
        { error: result.system ? 'system_credential_unavailable' : 'connection_required' },
        result.system ? 503 : 409,
      );
    return c.json(result);
  });
  return router;
}
