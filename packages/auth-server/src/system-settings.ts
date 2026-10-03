import { eq } from 'drizzle-orm';
import { applySystemSettings, currentSystemSettings, normalizeSystemSettings, type SystemSettings } from '@mcp/shared';
import { db } from './db.js';
import { meta } from './schema.js';

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

export { currentSystemSettings };
