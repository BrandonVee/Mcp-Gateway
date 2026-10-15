import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySystemSettings, currentSystemSettings } from '@/shared/index.js';
import { db } from '@/auth/infrastructure/database/client.js';
import { refreshSystemSettings, saveSystemSettings } from '@/auth/modules/system/settings.js';

test('settings refreshes coalesce and a late database read cannot overwrite settings just saved', async (t) => {
  const previous = currentSystemSettings(),
    mode = process.env.SYSTEM_CONFIG_MODE;
  process.env.SYSTEM_CONFIG_MODE = 'database';
  let reads = 0,
    release!: (value: any) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const query = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    limit() {
      reads++;
      return pending;
    },
  };
  t.mock.method(db, 'select', () => query as any);
  t.mock.method(db, 'insert', () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }) as any);
  const settings = {
    public_url: 'https://new.example.test',
    upstream_allowlist_enabled: true,
    upstream_hosts: ['new.example.test'],
  };
  try {
    const refreshes = Array.from({ length: 20 }, () => refreshSystemSettings());
    assert.equal(reads, 1);
    await saveSystemSettings(settings);
    release([{ value: JSON.stringify({ ...settings, public_url: 'https://old.example.test' }) }]);
    await Promise.all(refreshes);
    assert.deepEqual(currentSystemSettings(), settings);
    await refreshSystemSettings();
    assert.equal(reads, 1, 'fresh settings do not hit PostgreSQL per request');
  } finally {
    applySystemSettings(previous);
    if (mode === undefined) delete process.env.SYSTEM_CONFIG_MODE;
    else process.env.SYSTEM_CONFIG_MODE = mode;
  }
});
