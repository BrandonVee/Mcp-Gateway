import { bootstrapOriginAllowed, systemConfigured } from '@mcp/shared';

/** Preserve bootstrap same-host rules; after setup, only configured browser origins are accepted. */
export function browserOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  issuers: () => string[],
): boolean {
  return (
    !origin ||
    (!systemConfigured()
      ? bootstrapOriginAllowed(origin, host)
      : issuers()
          .map((url) => new URL(url).origin)
          .includes(origin))
  );
}
