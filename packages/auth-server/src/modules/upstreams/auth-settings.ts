import { isOAuthUrl } from '@/shared/security/urls.js';
import { mcpServerInstances } from '@/auth/infrastructure/database/schema.js';
import { encryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import { API_KEY_HEADER, isValidApiKey, isValidApiKeyPrefix } from '@/shared/security/credentials.js';

export type UpstreamAuthConfig = Pick<
  typeof mcpServerInstances.$inferSelect,
  | 'authMode'
  | 'apiKeyHeader'
  | 'apiKeyPrefix'
  | 'systemApiKey'
  | 'oauthAuthorizeUrl'
  | 'oauthTokenUrl'
  | 'oauthClientId'
  | 'oauthClientSecret'
  | 'oauthScopes'
  | 'oauthResource'
  | 'oauthIssuer'
  | 'oauthClientAuthMethod'
>;

/** 仅接受认证字段；省略密钥表示保留原值，切换模式会清空不再适用的字段。 */
export function authSettings(
  body: Record<string, unknown>,
  existing?: UpstreamAuthConfig,
): { values?: Partial<UpstreamAuthConfig>; error?: string } {
  const mode = body.auth_mode ?? 'none';
  if (mode !== 'none' && mode !== 'api_key' && mode !== 'system_api_key' && mode !== 'oauth' && mode !== 'system_oauth')
    return { error: 'auth_mode must be none, api_key, system_api_key, oauth or system_oauth' };
  const values: Partial<UpstreamAuthConfig> = { authMode: mode };
  if (mode !== 'api_key' && mode !== 'system_api_key') {
    values.apiKeyHeader = 'authorization';
    values.apiKeyPrefix = 'Bearer ';
  }
  if (mode !== 'oauth' && mode !== 'system_oauth') {
    values.oauthAuthorizeUrl = null;
    values.oauthTokenUrl = null;
    values.oauthClientId = null;
    values.oauthClientSecret = null;
    values.oauthScopes = null;
    values.oauthResource = null;
    values.oauthIssuer = null;
    values.oauthClientAuthMethod = 'none';
  }
  if (mode === 'api_key' || mode === 'system_api_key') {
    const header =
      body.api_key_header ??
      (existing?.authMode === 'api_key' || existing?.authMode === 'system_api_key'
        ? existing.apiKeyHeader
        : 'authorization');
    const prefix =
      body.api_key_prefix ??
      (existing?.authMode === 'api_key' || existing?.authMode === 'system_api_key' ? existing.apiKeyPrefix : 'Bearer ');
    if (typeof header !== 'string' || !API_KEY_HEADER.test(header))
      return { error: 'api_key_header must be authorization or an x-* header' };
    if (!isValidApiKeyPrefix(prefix)) return { error: 'invalid api_key_prefix' };
    values.apiKeyHeader = header.toLowerCase();
    values.apiKeyPrefix = prefix;
  }
  if (mode === 'system_api_key') {
    const key = body.system_api_key;
    if (key !== undefined && !isValidApiKey(key)) return { error: 'invalid_api_key' };
    if (key === undefined && (existing?.authMode !== 'system_api_key' || !existing.systemApiKey))
      return { error: 'system_api_key is required' };
    values.systemApiKey = typeof key === 'string' ? encryptCredential(key) : existing!.systemApiKey;
  } else {
    values.systemApiKey = null;
  }
  if (mode === 'oauth' || mode === 'system_oauth') {
    const authorizeUrl = body.oauth_authorize_url ?? existing?.oauthAuthorizeUrl;
    const tokenUrl = body.oauth_token_url ?? existing?.oauthTokenUrl;
    const clientId = body.oauth_client_id ?? existing?.oauthClientId;
    if (!isOAuthUrl(authorizeUrl) || !isOAuthUrl(tokenUrl))
      return { error: 'valid OAuth authorize and token URLs are required' };
    if (typeof clientId !== 'string' || !clientId.trim()) return { error: 'oauth_client_id is required' };
    if (
      body.oauth_client_secret !== undefined &&
      (typeof body.oauth_client_secret !== 'string' || body.oauth_client_secret.length > 4096)
    )
      return { error: 'invalid oauth_client_secret' };
    const clientAuthMethod =
      body.oauth_client_auth_method ??
      existing?.oauthClientAuthMethod ??
      (body.oauth_client_secret ? 'client_secret_basic' : 'none');
    if (
      clientAuthMethod !== 'none' &&
      clientAuthMethod !== 'client_secret_basic' &&
      clientAuthMethod !== 'client_secret_post'
    )
      return { error: 'invalid oauth_client_auth_method' };
    if (clientAuthMethod !== 'none' && !body.oauth_client_secret && !existing?.oauthClientSecret)
      return { error: 'oauth_client_secret is required' };
    if (clientAuthMethod === 'none' && body.oauth_client_secret)
      return { error: 'oauth_client_secret requires a client authentication method' };
    if (body.oauth_scopes !== undefined && (typeof body.oauth_scopes !== 'string' || body.oauth_scopes.length > 1000))
      return { error: 'invalid oauth_scopes' };
    if (body.oauth_resource !== undefined && body.oauth_resource !== '' && !isOAuthUrl(body.oauth_resource))
      return { error: 'invalid oauth_resource' };
    if (body.oauth_issuer !== undefined && body.oauth_issuer !== '' && !isOAuthUrl(body.oauth_issuer))
      return { error: 'invalid oauth_issuer' };
    values.oauthAuthorizeUrl = authorizeUrl;
    values.oauthTokenUrl = tokenUrl;
    values.oauthClientId = clientId.trim();
    values.oauthClientSecret =
      clientAuthMethod === 'none'
        ? null
        : body.oauth_client_secret
          ? encryptCredential(body.oauth_client_secret)
          : body.oauth_client_secret === undefined &&
              (existing?.authMode === 'oauth' || existing?.authMode === 'system_oauth')
            ? existing.oauthClientSecret
            : null;
    values.oauthScopes =
      typeof body.oauth_scopes === 'string' ? body.oauth_scopes.trim() || null : (existing?.oauthScopes ?? null);
    values.oauthResource =
      body.oauth_resource === ''
        ? null
        : typeof body.oauth_resource === 'string'
          ? body.oauth_resource
          : (existing?.oauthResource ?? null);
    values.oauthIssuer =
      body.oauth_issuer === ''
        ? null
        : typeof body.oauth_issuer === 'string'
          ? body.oauth_issuer
          : (existing?.oauthIssuer ?? null);
    values.oauthClientAuthMethod = clientAuthMethod;
  }
  return { values };
}
