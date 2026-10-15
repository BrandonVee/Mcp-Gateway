import { applySystemSettings, currentSystemSettings, normalizeSystemSettings, type SystemSettings } from '@mcp/shared';
import { eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { meta } from '@/auth/infrastructure/database/schema.js';

let refresh: Promise<void> | undefined;
let refreshedAt = 0;
let generation = 0;

export async function refreshSystemSettings(): Promise<void> {
  if (process.env.SYSTEM_CONFIG_MODE === 'file' || Date.now() - refreshedAt < 1000) return;
  if (refresh) return refresh;
  const revision = generation;
  refresh = loadSystemSettings(revision);
  try {
    await refresh;
  } finally {
    refresh = undefined;
  }
}

async function loadSystemSettings(revision: number): Promise<void> {
  if (process.env.SYSTEM_CONFIG_MODE === 'file') return;
  const [row] = await db.select({ value: meta.value }).from(meta).where(eq(meta.key, 'system_settings')).limit(1);
  if (revision !== generation) return;
  if (!row) {
    applySystemSettings({ public_url: null, upstream_allowlist_enabled: true, upstream_hosts: [] });
    refreshedAt = Date.now();
    return;
  }
  const settings = normalizeSystemSettings(JSON.parse(row.value));
  if (!settings) throw new Error('Invalid stored system settings');
  applySystemSettings(settings);
  refreshedAt = Date.now();
}

export async function saveSystemSettings(settings: SystemSettings): Promise<void> {
  const value = JSON.stringify(settings);
  await db
    .insert(meta)
    .values({ key: 'system_settings', value })
    .onConflictDoUpdate({ target: meta.key, set: { value } });
  generation++;
  applySystemSettings(settings);
  refreshedAt = Date.now();
}

/** Append to the latest persisted list without replacing unrelated settings. */
export async function addUpstreamHost(host: string): Promise<SystemSettings | null> {
  const settings = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(meta).where(eq(meta.key, 'system_settings')).limit(1).for('update');
    if (!row) return null;
    const current = normalizeSystemSettings(JSON.parse(row.value));
    if (!current) throw new Error('Invalid stored system settings');
    const next = normalizeSystemSettings({
      ...current,
      upstream_hosts: [...new Set([...current.upstream_hosts, host])],
    });
    if (!next) return null;
    await tx
      .update(meta)
      .set({ value: JSON.stringify(next) })
      .where(eq(meta.key, 'system_settings'));
    return next;
  });
  if (settings) {
    generation++;
    applySystemSettings(settings);
    refreshedAt = Date.now();
  }
  return settings;
}

export { currentSystemSettings };
