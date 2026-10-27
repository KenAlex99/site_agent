import { AppError } from './contracts.mjs';

/**
 * Reserved Site Agent -> Center LLDP upload entry point.
 * The payload contract and Center consumer are not enabled yet.
 * This stub performs no collection, queue writes, HTTP calls or CMDB writes.
 * @param {unknown} _snapshot Future approved LLDP observation snapshot.
 * @returns {Promise<never>} Rejects until the upload contract is implemented.
 */
export async function uploadLldpToCenter(_snapshot) {
  throw new AppError(501, 'LLDP_UPLOAD_NOT_IMPLEMENTED', 'LLDP upload is reserved and not enabled');
}
