import { env } from '@/gateway/config.js';

/** Reporting is best effort and identifies an exact saved credential, never the plaintext key. */
export async function reportCredentialStatus(input: {
  instance_id?: string;
  server?: string;
  upstream_url: string;
  user_id: number;
  auth_version: number;
  credential_version?: string;
  status: 'verified' | 'rejected';
}): Promise<boolean> {
  if (!input.credential_version) return false;
  try {
    const response = await fetch(new URL('/internal/credential-validation', env.credentialUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${env.credentialBrokerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(3000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
