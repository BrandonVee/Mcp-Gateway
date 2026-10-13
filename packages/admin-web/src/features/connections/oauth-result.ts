import type { MessageKey } from '@/web/i18n';

export function oauthResultKey(result: string): MessageKey {
  const keys: Record<string, MessageKey> = {
    connected: 'connections.oauthConnectionEstablished',
    cancelled: 'connections.oauthCancelled',
    invalid_state: 'connections.oauthInvalidState',
    session_expired: 'connections.oauthSessionExpired',
    unavailable: 'connections.oauthUnavailable',
    issuer_mismatch: 'connections.oauthIssuerMismatch',
    token_error: 'connections.oauthTokenError',
  };
  return Object.hasOwn(keys, result) ? keys[result] : 'connections.oauthUnknownError';
}
