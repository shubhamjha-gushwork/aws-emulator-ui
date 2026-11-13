import type { ResolvedConfig } from '../aws';
import { clientOptions } from '../aws';
import { addCompatMiddleware } from '../compat';

export type Params = Record<string, unknown>;

export interface Ctx {
  cfg: ResolvedConfig;
  client<T>(Ctor: new (opts: ReturnType<typeof clientOptions> & Record<string, unknown>) => T, extra?: Record<string, unknown>): T;
}

export type Action = (ctx: Ctx, p: Params) => Promise<unknown>;

export interface ServiceModule {
  actions: Record<string, Action>;
  /** Cheap resource counts for the overview page. */
  counts: (ctx: Ctx) => Promise<{ label: string; value: number }[]>;
}

export function makeCtx(cfg: ResolvedConfig): Ctx {
  const cache = new Map<unknown, unknown>();
  return {
    cfg,
    client(Ctor, extra) {
      if (!cache.has(Ctor)) {
        const c = new Ctor({ ...clientOptions(cfg), ...(extra ?? {}) });
        addCompatMiddleware(c);
        cache.set(Ctor, c);
      }
      return cache.get(Ctor) as never;
    },
  };
}

export class InputError extends Error {
  name = 'InputError';
}

export const str = (p: Params, k: string, required = true): string => {
  const v = p[k];
  if (typeof v === 'string' && v.length) return v;
  if (typeof v === 'number') return String(v);
  if (required) throw new InputError(`Missing "${k}"`);
  return '';
};
export const optStr = (p: Params, k: string) => str(p, k, false) || undefined;
export const num = (p: Params, k: string, dflt?: number): number => {
  const v = p[k];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  if (Number.isFinite(n)) return n;
  if (dflt !== undefined) return dflt;
  throw new InputError(`"${k}" must be a number`);
};
export const bool = (p: Params, k: string) => p[k] === true || p[k] === 'true';
export const strList = (p: Params, k: string): string[] => {
  const v = p[k];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
};
export const json = (text: string, what = 'JSON'): unknown => {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InputError(`${what} is not valid JSON: ${(e as Error).message}`);
  }
};

const dec = new TextDecoder();
export const decodeBytes = (b?: Uint8Array) => (b ? dec.decode(b) : '');

/** Runs an action and returns its count, or 0 if the emulator refuses it. */
export async function safeCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch {
    return -1;
  }
}

/** Default dummy role ARN used for create forms (the emulator does not evaluate IAM policies). */
export const DEFAULT_ROLE_ARN = 'arn:aws:iam::000000000000:role/aws-emulator-ui-role';
