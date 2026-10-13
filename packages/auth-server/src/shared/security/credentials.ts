/** Keep API key limits identical for administrator and personal connection writes. */
export const API_KEY_MAX_LENGTH = 4096;
export const API_KEY_HEADER = /^(authorization|x-[a-z0-9-]{1,60})$/i;
export function isValidApiKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value.length <= API_KEY_MAX_LENGTH &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
