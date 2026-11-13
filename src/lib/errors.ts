export interface ApiError {
  name: string;
  message: string;
  status?: number;
  /** The emulator answered NotImplemented / 501 — the API exists on AWS but the emulator doesn't do it yet. */
  notImplemented: boolean;
  /** Could not reach the emulator at all. */
  connection: boolean;
}

export function isNotImplemented(name: string, message: string, status?: number) {
  return (
    name === 'NotImplemented' ||
    name === 'NotImplementedException' ||
    status === 501 ||
    /not implemented in this emulator/i.test(message) ||
    /unknown operation/i.test(message)
  );
}

export function normalizeError(e: unknown): ApiError {
  const err = e as { name?: string; Code?: string; message?: string; code?: string; cause?: { code?: string }; $metadata?: { httpStatusCode?: number } };
  const name = err?.name || err?.Code || 'Error';
  const message = err?.message || String(e);
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.code || err?.cause?.code || '';
  const connection = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) || /ECONNREFUSED|socket hang up|fetch failed/.test(message);
  return { name, message, status, notImplemented: isNotImplemented(name, message, status), connection };
}
