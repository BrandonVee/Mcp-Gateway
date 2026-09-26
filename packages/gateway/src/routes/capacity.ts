const configured = Number(process.env.UPSTREAM_MAX_ACTIVE_REQUESTS ?? 100);
export const maxActiveUpstreamRequests = Number.isSafeInteger(configured) && configured > 0 ? configured : 100;
let active = 0;

/** Counts requests until their upstream response has been completely handled. */
export function reserveUpstreamSlot(): (() => void) | null {
  if (active >= maxActiveUpstreamRequests) return null;
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
  };
}

export function activeUpstreamRequests(): number {
  return active;
}
