import { promises as fs } from 'fs';
import path from 'path';
import { emulatorHome, endpointPort } from './settings';

/** Minimal INI parser for the emulator's credentials file. */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      section = m[1].trim();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0 && section) out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export interface EmulatorRunFiles {
  dir: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  ca?: string;
}

/** Reads the files a running emulator writes to ~/.aws/emulator/<port>/ (they change every run). */
export async function readRunFiles(endpoint: string): Promise<EmulatorRunFiles> {
  const dir = path.join(emulatorHome(), String(endpointPort(endpoint)));
  const res: EmulatorRunFiles = { dir };
  try {
    const ini = parseIni(await fs.readFile(path.join(dir, 'emulator_credentials'), 'utf8'));
    const d = ini.default;
    if (d?.aws_access_key_id && d?.aws_secret_access_key) {
      res.credentials = { accessKeyId: d.aws_access_key_id, secretAccessKey: d.aws_secret_access_key };
    }
  } catch {
    /* emulator not running locally or started with --auth off */
  }
  try {
    res.ca = await fs.readFile(path.join(dir, 'ca.pem'), 'utf8');
  } catch {
    /* no CA (http endpoint or remote emulator) */
  }
  return res;
}
