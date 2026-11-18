import { useEffect } from 'react';
import { useInterval } from './useInterval';

const visible = () => document.visibilityState === 'visible';

/**
 * Calls `poll` every `delayMs` while the tab is visible, and at once when a hidden tab becomes
 * visible again (design §12). `null` stops polling.
 */
export function useVisiblePolling(poll: () => void, delayMs: number | null) {
  useInterval(() => {
    if (visible()) poll();
  }, delayMs);
  useEffect(() => {
    if (delayMs === null) return;
    const onVisibilityChange = () => {
      if (visible()) poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [delayMs, poll]);
}
