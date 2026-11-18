import { useEffect, useState } from 'react';
import { getCachedServerCapabilities, type Capabilities } from '@/services/api/capabilities';

/**
 * One value derived from the server's capabilities: `initial` until they are read, and for as
 * long as they cannot be read (a failed read leaves the feature off, as on upstream).
 * `select` must be stable (a module-level function): a new one reads the capabilities again.
 */
export function useServerCapability<T>(select: (capabilities: Capabilities) => T, initial: T): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let live = true;
    getCachedServerCapabilities().then(
      (capabilities) => live && setValue(select(capabilities)),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [select]);
  return value;
}
