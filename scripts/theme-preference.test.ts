import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('../packages/admin-web/public/theme-init.js', import.meta.url), 'utf8');
function initialTheme(saved: string | null, dark: boolean, blocked = false, mediaAvailable = true) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  let browserColor = '';
  runInNewContext(script, {
    localStorage: {
      getItem: () => {
        if (blocked) throw new Error('storage disabled');
        return saved;
      },
    },
    window: mediaAvailable ? { matchMedia: () => ({ matches: dark }) } : {},
    document: {
      documentElement: root,
      querySelector: () => ({
        setAttribute: (_key: string, value: string) => {
          browserColor = value;
        },
      }),
    },
  });
  return { mode: root.dataset.theme, nativeControls: root.style.colorScheme, browserColor };
}

test('first paint respects saved appearance and system preference before React mounts', () => {
  for (const [saved, dark, expected] of [
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
    [null, true, 'dark'],
    ['invalid', false, 'light'],
  ] as const) {
    assert.deepEqual(initialTheme(saved, dark), {
      mode: expected,
      nativeControls: expected,
      browserColor: expected === 'dark' ? '#070b13' : '#f3f6fb',
    });
  }
});

test('disabled storage and missing media API still allow the login page to render', () => {
  assert.equal(initialTheme('light', true, true).mode, 'dark');
  assert.equal(initialTheme(null, false, true, false).mode, 'light');
});
