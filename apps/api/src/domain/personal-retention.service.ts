import { env } from '../env.js';

/** Owner has not approved periods. Fail closed even if config is changed early. */
export async function cleanupPersonalRetention(): Promise<{ disabled: boolean }> {
  if (!env.PERSONAL_RETENTION_ENABLED) return { disabled: true };
  throw new Error('Personal retention is not ready to enable: approved periods and address-isolation implementation are still required');
}
