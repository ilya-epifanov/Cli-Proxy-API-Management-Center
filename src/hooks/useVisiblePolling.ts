import { useEffect, useRef } from 'react';
import { useInterval } from './useInterval';

const visible = () => document.visibilityState === 'visible';

/**
 * Calls `poll` every `delayMs` while the tab is visible, and at once when a hidden tab becomes
 * visible again (design §12). `null` stops polling. `poll` does not need to be memoized: the
 * latest one is always called.
 */
export function useVisiblePolling(poll: () => void, delayMs: number | null) {
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);
  useInterval(() => {
    if (visible()) pollRef.current();
  }, delayMs);
  useEffect(() => {
    if (delayMs === null) return;
    const onVisibilityChange = () => {
      if (visible()) pollRef.current();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [delayMs]);
}
