import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { DeployClients } from './client';
import type { EnvMap } from './envfile';
import { PLACEHOLDER_VALUE } from './types';

/**
 * Build a placeholder secret's JSON by merging into what is already on Floci, so a deploy never
 * wipes keys another config uses (several repos share one secret) or values filled in by hand.
 * Per key: the local env file wins, then an existing non-placeholder value, then the placeholder.
 * Never log the result; only the key-name lists are safe to print.
 */
export function mergeSecretPayload(existing: string | undefined, keys: string[], fileEnv: EnvMap): { secretString: string; filled: string[]; kept: string[]; missing: string[] } {
  let base: Record<string, unknown> = {};
  let plainExisting: string | undefined;
  if (existing !== undefined) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
      else plainExisting = existing;
    } catch {
      plainExisting = existing;
    }
  }
  const filled: string[] = [];
  const kept: string[] = [];
  const missing: string[] = [];
  if (!keys.length && plainExisting !== undefined && plainExisting !== PLACEHOLDER_VALUE) {
    return { secretString: plainExisting, filled, kept: ['(whole secret)'], missing };
  }
  const out: Record<string, unknown> = { ...base };
  for (const k of keys.length ? keys : ['VALUE']) {
    if (Object.prototype.hasOwnProperty.call(fileEnv, k)) {
      out[k] = fileEnv[k];
      filled.push(k);
    } else if (Object.prototype.hasOwnProperty.call(base, k) && base[k] !== PLACEHOLDER_VALUE && base[k] !== '' && base[k] !== null) {
      kept.push(k);
    } else {
      out[k] = PLACEHOLDER_VALUE;
      missing.push(k);
    }
  }
  return { secretString: JSON.stringify(out, null, 2), filled, kept, missing };
}

/** Create the secret, or merge this config's keys into the existing one (see mergeSecretPayload). */
export async function upsertPlaceholderSecret(c: Pick<DeployClients, 'secrets'>, name: string, keys: string[], fileEnv: EnvMap, description: string) {
  let existing: string | undefined;
  let exists = false;
  try {
    const cur = await c.secrets.send(new GetSecretValueCommand({ SecretId: name }));
    exists = true;
    existing = cur.SecretString;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (!/ResourceNotFound|not found|does not exist/i.test(`${err.name ?? ''} ${err.message ?? ''}`)) throw e;
  }
  const merged = mergeSecretPayload(existing, keys, fileEnv);
  if (exists) await c.secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: merged.secretString }));
  else await c.secrets.send(new CreateSecretCommand({ Name: name, SecretString: merged.secretString, Description: description }));
  return merged;
}
