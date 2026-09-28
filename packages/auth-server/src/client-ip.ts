import { BlockList, isIP } from 'node:net';

function normalizedIp(value: string): string | null {
  const address = value.trim().replace(/^\[|\]$/g, '');
  const unwrapped = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(unwrapped) ? unwrapped : null;
}

/** Walk a trusted proxy chain from the socket backwards; never trust arbitrary XFF. */
export function resolveClientIp(socketAddress: string, forwardedFor: string | undefined, trustedProxyIps: string): string {
  const peer = normalizedIp(socketAddress) ?? 'unknown';
  const trusted = new BlockList();
  for (const entry of trustedProxyIps.split(',').map((value) => value.trim()).filter(Boolean)) {
    const [host, prefix, extra] = entry.split('/');
    if (extra !== undefined) continue;
    const address = normalizedIp(host);
    if (!address) continue;
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) trusted.addAddress(address, type);
    else if (/^\d+$/.test(prefix) && Number(prefix) <= (type === 'ipv6' ? 128 : 32)) {
      trusted.addSubnet(address, Number(prefix), type);
    }
  }
  const isTrusted = (address: string): boolean => Boolean(isIP(address))
    && trusted.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  if (!isTrusted(peer) || !forwardedFor) return peer;
  const chain = forwardedFor.split(',').map(normalizedIp);
  if (chain.some((ip) => !ip)) return peer;
  for (let index = chain.length - 1; index >= 0; index--) {
    if (!isTrusted(chain[index]!)) return chain[index]!;
  }
  return chain[0] ?? peer;
}
