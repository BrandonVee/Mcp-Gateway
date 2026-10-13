import { bigint, text } from 'drizzle-orm/pg-core';

/** 每次构建新列对象，保证端点兼容字段与上游字段同型，但不共享 Drizzle builder。 */
export function upstreamAuthColumns() {
  return {
    authMode: text('auth_mode')
      .$type<'none' | 'api_key' | 'system_api_key' | 'oauth' | 'system_oauth'>()
      .notNull()
      .default('none'),
    authRevision: bigint('auth_revision', { mode: 'number' }).notNull().default(0),
    apiKeyHeader: text('api_key_header').notNull().default('authorization'),
    apiKeyPrefix: text('api_key_prefix').notNull().default('Bearer '),
    systemApiKey: text('system_api_key'),
    oauthAuthorizeUrl: text('oauth_authorize_url'),
    oauthTokenUrl: text('oauth_token_url'),
    oauthClientId: text('oauth_client_id'),
    oauthClientSecret: text('oauth_client_secret'),
    oauthScopes: text('oauth_scopes'),
    oauthResource: text('oauth_resource'),
    oauthIssuer: text('oauth_issuer'),
    oauthClientAuthMethod: text('oauth_client_auth_method')
      .$type<'none' | 'client_secret_basic' | 'client_secret_post'>()
      .notNull()
      .default('none'),
  };
}
