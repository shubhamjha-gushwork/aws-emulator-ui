/** JSON replacer for AWS SDK outputs: Sets → arrays, bytes → base64, bigint → string. */
export function awsReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function stripMetadata<T>(v: T): T {
  if (v && typeof v === 'object' && !Array.isArray(v) && '$metadata' in (v as object)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { $metadata, ...rest } = v as Record<string, unknown>;
    return rest as T;
  }
  return v;
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, awsReplacer), { status, headers: { 'content-type': 'application/json' } });
}
