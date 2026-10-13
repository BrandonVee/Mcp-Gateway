import type { SystemUpdateStatus } from '@/web/types';

export type UpdateTaskState = 'running' | 'succeeded' | 'failed' | 'missing' | 'unknown';

/** A 202 starts a worker; only a healthy replacement means the update succeeded. */
export async function waitForSystemUpdate(
  api: {
    systemUpdate: () => Promise<Pick<SystemUpdateStatus, 'container_id' | 'container_ready'>>;
    systemUpdateTask: (id: string) => Promise<{ status: UpdateTaskState }>;
  },
  containerId: string,
  updaterId: string,
  options: { attempts?: number; pause?: () => Promise<void> } = {},
): Promise<'completed' | 'failed' | 'timeout'> {
  let missingCount = 0;
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 3_000)));
  for (let attempt = 0; attempt < (options.attempts ?? 200); attempt++) {
    await pause();
    try {
      const status = await api.systemUpdate();
      if (status.container_id && status.container_id !== containerId && status.container_ready !== false)
        return 'completed';
      const task = await api.systemUpdateTask(updaterId).catch(() => ({ status: 'unknown' as const }));
      if (task.status === 'failed') return 'failed';
      // AutoRemove can race the replacement response; do not fail on one observation.
      missingCount =
        status.container_id === containerId && ['missing', 'succeeded'].includes(task.status) ? missingCount + 1 : 0;
      if (missingCount >= 2) return 'failed';
    } catch {
      missingCount = 0;
      /* The application is restarting. */
    }
  }
  return 'timeout';
}
