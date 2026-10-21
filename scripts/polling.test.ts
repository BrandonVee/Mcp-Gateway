import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollWhileVisible } from '@/web/utils/polling';

function visibilitySource(hidden = false) {
  const source = Object.assign(new EventTarget(), { hidden });
  return {
    source,
    setHidden(value: boolean) {
      source.hidden = value;
      source.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

test('polling pauses in background tabs and refreshes immediately when visible again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const visibility = visibilitySource();
  let calls = 0;
  const stop = pollWhileVisible(
    async () => {
      calls++;
    },
    10000,
    visibility.source,
  );
  t.after(stop);

  assert.equal(calls, 1);
  await Promise.resolve();
  t.mock.timers.tick(10000);
  assert.equal(calls, 2);
  await Promise.resolve();

  visibility.setHidden(true);
  t.mock.timers.tick(60000);
  assert.equal(calls, 2);

  visibility.setHidden(false);
  assert.equal(calls, 3);
  await Promise.resolve();
  t.mock.timers.tick(10000);
  assert.equal(calls, 4);

  stop();
  await Promise.resolve();
  t.mock.timers.tick(60000);
  visibility.setHidden(true);
  visibility.setHidden(false);
  assert.equal(calls, 4);
});

test('an initially hidden page waits until visible before requesting data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const visibility = visibilitySource(true);
  let calls = 0;
  const stop = pollWhileVisible(
    async () => {
      calls++;
    },
    5000,
    visibility.source,
  );
  t.after(stop);

  t.mock.timers.tick(60000);
  assert.equal(calls, 0);
  visibility.setHidden(false);
  assert.equal(calls, 1);
  await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal(calls, 2);
});

test('slow requests never overlap, including when a tab is hidden and shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const visibility = visibilitySource();
  let calls = 0;
  let complete!: () => void;
  const stop = pollWhileVisible(
    () => {
      calls++;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    5000,
    visibility.source,
  );
  t.after(stop);

  t.mock.timers.tick(20000);
  visibility.setHidden(true);
  visibility.setHidden(false);
  assert.equal(calls, 1);

  complete();
  await Promise.resolve();
  t.mock.timers.tick(4999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);

  stop();
  complete();
  await Promise.resolve();
  t.mock.timers.tick(20000);
  visibility.setHidden(true);
  visibility.setHidden(false);
  assert.equal(calls, 2);
});

test('a request finishing in a hidden tab waits for visibility before polling again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const visibility = visibilitySource();
  let calls = 0;
  let complete!: () => void;
  const stop = pollWhileVisible(
    () => {
      calls++;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    5000,
    visibility.source,
  );
  t.after(stop);

  visibility.setHidden(true);
  complete();
  await Promise.resolve();
  t.mock.timers.tick(60000);
  assert.equal(calls, 1);

  visibility.setHidden(false);
  assert.equal(calls, 2);
  stop();
  complete();
  await Promise.resolve();
});
