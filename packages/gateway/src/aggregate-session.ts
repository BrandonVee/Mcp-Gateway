import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AggregateError, type AggregateMember, type AggregateSession } from '@/gateway/aggregate.js';

const commit = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if KEYS[2] ~= KEYS[1] and redis.call('GET', KEYS[2]) ~= ARGV[4] then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1
`;
const renewLock = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],60) end return 0";
const releaseLock = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0";

/** Business RPCs use snapshots. Only member initialization and atomic state changes synchronize. */
export class AggregateSessionStore {
  constructor(
    private redis: Pick<Redis, 'get' | 'set' | 'eval' | 'expire'>,
    readonly key: string,
    private owner: number | string,
    private authVersion: number,
    private ttl: number,
  ) {}

  async read(): Promise<AggregateSession> {
    const raw = await this.redis.get(this.key);
    return this.decode(raw);
  }

  private decode(raw: string | null): AggregateSession {
    const session: AggregateSession | null = raw ? JSON.parse(raw) : null;
    if (!session || session.owner !== this.owner || session.authVersion !== this.authVersion)
      throw new AggregateError('session_not_found', 404);
    return session;
  }

  /** Compare-and-swap preserves concurrent member/catalog changes and never revives a deleted session. */
  async update<T>(change: (session: AggregateSession) => T, guard?: { key: string; token: string }) {
    for (let attempt = 0; attempt < 64; attempt++) {
      const raw = await this.redis.get(this.key);
      const session = this.decode(raw);
      const value = change(session);
      const saved = Number(
        await this.redis.eval(
          commit,
          2,
          this.key,
          guard?.key ?? this.key,
          raw!,
          JSON.stringify(session),
          this.ttl,
          guard?.token ?? '',
        ),
      );
      if (saved === 1) return { session, value };
      if (saved === -1) throw new AggregateError('session_state_changed', 503);
    }
    throw new AggregateError('session_state_changed', 503);
  }

  async member(
    id: string,
    revision: number,
    initialize: () => Promise<AggregateMember>,
    credentialVersion?: string,
  ): Promise<AggregateMember> {
    const key = `${this.key}:member:${id}:lock`,
      token = randomUUID();
    const deadline = Date.now() + 75_000;
    while ((await this.redis.set(key, token, 'EX', 60, 'NX')) !== 'OK') {
      if (Date.now() >= deadline) throw new AggregateError('upstream_initialize_busy', 503, id);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const member = (await this.read()).members[id];
      if (member?.revision === revision && member.credentialVersion === credentialVersion) return member;
    }
    const heartbeat = setInterval(() => {
      void this.redis.eval(renewLock, 1, key, token).catch(() => undefined);
    }, 15_000);
    heartbeat.unref();
    try {
      const previous = (await this.read()).members[id];
      if (previous?.revision === revision && previous.credentialVersion === credentialVersion) return previous;
      const member = await initialize();
      await this.update(
        (session) => {
          session.members[id] = member;
        },
        { key, token },
      );
      return member;
    } finally {
      clearInterval(heartbeat);
      await this.redis.eval(releaseLock, 1, key, token).catch(() => undefined);
    }
  }

  touch() {
    return this.redis.expire(this.key, this.ttl);
  }
}
