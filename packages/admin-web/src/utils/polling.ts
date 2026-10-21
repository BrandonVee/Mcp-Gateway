type VisibilitySource = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

/** Refresh visible pages without overlapping requests or keeping background timers alive. */
export function pollWhileVisible(
  refresh: () => Promise<void>,
  intervalMs: number,
  visibility: VisibilitySource = document,
) {
  let disposed = false;
  let fetching = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const poll = async () => {
    clearTimer();
    if (disposed || visibility.hidden || fetching) return;
    fetching = true;
    try {
      await refresh();
    } finally {
      fetching = false;
      if (!disposed && !visibility.hidden) timer = setTimeout(() => void poll(), intervalMs);
    }
  };
  const onVisibilityChange = () => {
    clearTimer();
    if (!visibility.hidden) void poll();
  };

  visibility.addEventListener('visibilitychange', onVisibilityChange);
  void poll();
  return () => {
    disposed = true;
    clearTimer();
    visibility.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
