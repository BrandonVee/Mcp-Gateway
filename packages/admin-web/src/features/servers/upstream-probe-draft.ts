import type { UpstreamTestAuthInput } from '../../types';

export interface UpstreamProbeDraft {
  url: string;
  authentication: UpstreamTestAuthInput;
}

/** Snapshot the effective probe settings; this is independent of the save payload. */
export function upstreamProbeDraft(values: Record<string, unknown>, instanceId?: string): UpstreamProbeDraft {
  const mode = values.auth_mode as UpstreamTestAuthInput['auth_mode'];
  return {
    url: typeof values.url === 'string' ? values.url.trim() : '',
    authentication: {
      instance_id: instanceId,
      auth_mode: mode,
      ...(['api_key', 'system_api_key'].includes(mode ?? '')
        ? {
            ...(mode === 'system_api_key' ? { system_api_key: (values.system_api_key as string) || undefined } : {}),
            api_key_header: values.api_key_header as string | undefined,
            api_key_prefix: values.api_key_prefix as string | undefined,
          }
        : {}),
    },
  };
}

/** Never log or serialize the draft merely to compare it: it may contain a secret. */
export function sameUpstreamProbeDraft(a: UpstreamProbeDraft, b: UpstreamProbeDraft): boolean {
  return (
    a.url === b.url &&
    a.authentication.instance_id === b.authentication.instance_id &&
    a.authentication.auth_mode === b.authentication.auth_mode &&
    a.authentication.system_api_key === b.authentication.system_api_key &&
    a.authentication.api_key_header === b.authentication.api_key_header &&
    a.authentication.api_key_prefix === b.authentication.api_key_prefix
  );
}
