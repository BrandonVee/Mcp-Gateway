import { applySystemSettings, currentSystemSettings, normalizeSystemSettings, type SystemSettings } from '@mcp/shared';
import { eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { meta } from '@/auth/infrastructure/database/schema.js';

export async function refreshSystemSettings(): Promise<void> {
  if (process.env.SYSTEM_CONFIG_MODE === 'file') return;
  const [row] = await db.select({ value: meta.value }).from(meta).where(eq(meta.key, 'system_settings')).limit(1);
  if (!row) {
    applySystemSettings({ public_url: null, upstream_allowlist_enabled: true, upstream_hosts: [] });
    return;
  }
  const settings = normalizeSystemSettings(JSON.parse(row.value));
  if (!settings) throw new Error('Invalid stored system settings');
  applySystemSettings(settings);
}

export async function saveSystemSettings(settings: SystemSettings): Promise<void> {
  const value = JSON.stringify(settings);
  await db
    .insert(meta)
    .values({ key: 'system_settings', value })
    .onConflictDoUpdate({ target: meta.key, set: { value } });
  applySystemSettings(settings);
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
  if (settings) applySystemSettings(settings);
  return settings;
}

export { currentSystemSettings };
