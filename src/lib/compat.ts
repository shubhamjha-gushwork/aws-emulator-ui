import { Readable } from 'stream';

/**
 * AWS Emulator sometimes serializes epoch timestamps with nanosecond precision
 * (e.g. "createdAt":1794581585.444590867). Real AWS sends at most millisecond precision, and the
 * AWS SDK for JavaScript v3 refuses the longer form ("Epoch timestamps must be expressed as floating
 * point numbers…"). We trim the fraction to 3 digits in JSON responses before the SDK parses them.
 */
export function trimEpochPrecision(text: string): string {
  return text.replace(/(:\s*\d{9,11}\.\d{3})\d+(?=\s*[,}\]])/g, '$1');
}

type Middleware = (next: (args: unknown) => Promise<{ response: unknown }>) => (args: unknown) => Promise<{ response: unknown }>;

export const epochPrecisionMiddleware: Middleware = (next) => async (args) => {
  const result = await next(args);
  const res = result.response as { headers?: Record<string, string>; body?: unknown };
  const ct = res?.headers?.['content-type'] ?? res?.headers?.['Content-Type'] ?? '';
  if (!/json/i.test(ct) || !res.body || typeof (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') return result;
  const chunks: Buffer[] = [];
  for await (const ch of res.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(ch));
  const fixed = trimEpochPrecision(Buffer.concat(chunks).toString('utf8'));
  res.body = Readable.from([Buffer.from(fixed, 'utf8')]);
  return result;
};

export function addCompatMiddleware(client: unknown) {
  const stack = (client as { middlewareStack?: { add: (m: unknown, o: unknown) => void } }).middlewareStack;
  stack?.add(epochPrecisionMiddleware, { step: 'deserialize', priority: 'low', name: 'awsEmulatorEpochPrecision' });
}
