import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createPkceAuthorization } from '@/auth/shared/security/pkce.js';
import { db } from '@/auth/infrastructure/database/client.js';
import { upstreamCredentials, upstreamOAuthStates } from '@/auth/infrastructure/database/schema.js';
import { encryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';
import { lockOwner, lockUpstream, ownerFor } from '@/auth/modules/upstreams/connection-service.js';
import { upstreamCallbackUrl, connectionPortalUrl } from '@/auth/modules/connections/redirects.js';
import { exchangeOAuthToken, tokenExpiry } from '@/auth/modules/upstreams/token-exchange.js';
/** Registers oauth operations for concrete upstreams, with per-owner credential isolation. */
export function registerOauthRoutes(router: Hono) {
  router.post('/me/upstreams/:id/oauth', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { state, verifier, challenge } = createPkceAuthorization();
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
    url.searchParams.set('redirect_uri', upstreamCallbackUrl(target.id));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
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
      return c.redirect(connectionPortalUrl('invalid_state', c.req.param('id')));
    const user = await currentUser(c);
    if (!user || user.id !== state.userId || (state.system && user.role !== 'admin'))
      return c.redirect(connectionPortalUrl('session_expired', state.instanceId));
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
    if (!target) return c.redirect(connectionPortalUrl('invalid_state', state.instanceId));
    if (!code || c.req.query('error')) {
      await db.delete(upstreamOAuthStates).where(eq(upstreamOAuthStates.state, state.state));
      return c.redirect(connectionPortalUrl('cancelled', state.instanceId));
    }
    const body = await exchangeOAuthToken(
      target,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: upstreamCallbackUrl(target.id),
        code_verifier: state.verifier,
      }),
    ).catch(() => null);
    if (!body) {
      await db.delete(upstreamOAuthStates).where(eq(upstreamOAuthStates.state, state.state));
      return c.redirect(connectionPortalUrl('token_error', state.instanceId));
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
    return c.redirect(connectionPortalUrl(saved ? 'connected' : 'invalid_state', state.instanceId));
  });
}
