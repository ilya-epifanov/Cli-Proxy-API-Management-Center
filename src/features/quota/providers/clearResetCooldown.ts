import { authFilesApi } from '@/services/api/authFiles';

/**
 * Clears the gateway's routing cooldown after a provider confirmed a quota reset.
 * The reset goes to the provider through api-call, so the gateway never sees it
 * and would otherwise skip the account until the cooldown deadline.
 */
export async function clearResetCooldown(authIndex: string): Promise<void> {
  const result = await authFilesApi.resetCooldown(authIndex);
  if (result.status !== 'ok' || result.auth_index !== authIndex) {
    throw new Error('Invalid cooldown reset response');
  }
}
