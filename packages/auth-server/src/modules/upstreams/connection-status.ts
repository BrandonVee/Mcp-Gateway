import { accessTokenValid } from '@/auth/modules/upstreams/token-exchange.js';

export function connectionStatus(
  mode: string,
  row?: {
    mode: string;
    expiresAt: number | null;
    hasRefreshToken: boolean;
    validationStatus: 'saved' | 'verified' | 'rejected';
  },
) {
  if (mode === 'none' || mode === 'system_api_key') return 'not_required';
  if (!row || row.mode !== (mode === 'api_key' ? 'api_key' : 'oauth')) return 'not_connected';
  if (row.validationStatus === 'rejected') return 'rejected';
  if (!accessTokenValid(row.expiresAt) && !row.hasRefreshToken) return 'expired';
  return mode === 'api_key' && row.validationStatus !== 'verified' ? 'saved' : 'connected';
}
