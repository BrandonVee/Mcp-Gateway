import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForSystemUpdate, type UpdateTaskState } from '../packages/admin-web/src/features/settings/update-task';

function poll(sequence: Array<{ id?: string; ready?: boolean; task?: UpdateTaskState; offline?: boolean }>) {
  let reads = 0;
  const api = {
    systemUpdate: async () => {
      const step = sequence[Math.min(reads++, sequence.length - 1)];
      if (step.offline) throw new Error('restarting');
      return { container_id: step.id ?? 'old', container_ready: step.ready ?? true };
    },
    systemUpdateTask: async () => ({ status: sequence[Math.min(reads - 1, sequence.length - 1)].task ?? 'running' }),
  };
  return { api, reads: () => reads };
}
const options = { attempts: 5, pause: async () => {} };

test('a failed or removed worker stops waiting while the original application is still healthy', async () => {
  const failed = poll([{ task: 'failed' }]);
  assert.equal(await waitForSystemUpdate(failed.api, 'old', 'worker', options), 'failed');
  assert.equal(failed.reads(), 1);
  const removed = poll([{ task: 'missing' }]);
  assert.equal(await waitForSystemUpdate(removed.api, 'old', 'worker', options), 'failed');
  assert.equal(removed.reads(), 2);
});

test('a replacement must be healthy; temporary restart and worker removal races do not report failure', async () => {
  const replacement = poll([{ task: 'missing' }, { offline: true }, { id: 'new', ready: false }, { id: 'new' }]);
  assert.equal(await waitForSystemUpdate(replacement.api, 'old', 'worker', options), 'completed');
  assert.equal(replacement.reads(), 4);
  const race = poll([{ task: 'missing' }, { id: 'new' }]);
  assert.equal(await waitForSystemUpdate(race.api, 'old', 'worker', options), 'completed');
});

test('an ongoing image pull is allowed to continue until the polling deadline', async () => {
  const running = poll([{ task: 'running' }]);
  assert.equal(await waitForSystemUpdate(running.api, 'old', 'worker', options), 'timeout');
  assert.equal(running.reads(), 5);
});
