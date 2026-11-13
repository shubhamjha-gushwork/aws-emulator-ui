#!/usr/bin/env node
import path from 'path';
import { loadSettings } from '../lib/settings';
import { deployAll, destroyById, inspectSecrets, listManifests, type DeployOptions } from '../lib/deploy';
import type { Plan } from '../lib/deploy/types';
import { renderEnvExample } from '../lib/deploy/envfile';
import fs from 'fs';

function usage(code = 0): never {
  const text = `aws-emulator — deploy serverless.yml / trinity.yml to local Floci

Usage:
  aws-emulator deploy <path-to-repo-or-file> [options]
  aws-emulator destroy <path-or-deployment-id> [options]
  aws-emulator list
  aws-emulator plan <path>             (alias for deploy --dry-run)
  aws-emulator secrets <path> [options]
                         List required secret keys and which are missing

Options:
  --stage <name>         Stage (default: local)
  --region <region>      Region (default: us-east-1, or the UI setting)
  --endpoint <url>       Floci endpoint (default: http://127.0.0.1:4566)
  --dry-run              Print the plan; do not create anything
  --no-build             Skip docker build/push (Trinity)
  --no-run               Create only: disable triggers, ECS desiredCount 0
  --desired-count <n>    Override ECS desiredCount (Trinity services)
  --kind serverless|trinity
                         Only configs of this kind when a directory has both
  --env-file <path>      Local dotenv file used to fill placeholder secrets
                         (default: .env.local, then .env, in the target repo)
  --write-example [path] With the secrets command: write a key-names-only template
                         (default: <repo>/.env.example)

npm run deploy:local -- <path> [options]   same as aws-emulator deploy
`;
  console[code ? 'error' : 'log'](text);
  process.exit(code);
}

async function defaults(): Promise<Pick<DeployOptions, 'endpoint' | 'region' | 'stage'>> {
  let endpoint = process.env.FLOCI_ENDPOINT || process.env.AWS_ENDPOINT_URL || 'http://127.0.0.1:4566';
  let region = process.env.AWS_DEFAULT_REGION || 'us-east-1';
  try {
    const s = await loadSettings();
    endpoint = process.env.FLOCI_ENDPOINT || process.env.AWS_ENDPOINT_URL || s.endpoint || endpoint;
    region = s.region || region;
  } catch {
    /* UI settings are optional for the CLI */
  }
  return { endpoint, region, stage: 'local' };
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const cmd = args.shift();
  const opts: Record<string, string | boolean> = {};
  const positional: string[] = [];
  while (args.length) {
    const a = args.shift()!;
    if (a === '-h' || a === '--help') usage(0);
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-build') opts.noBuild = true;
    else if (a === '--no-run') opts.noRun = true;
    else if (a === '--write-example') {
      const peek = args[0];
      if (peek && !peek.startsWith('--')) opts['write-example'] = args.shift()!;
      else opts['write-example'] = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args.shift();
      if (!val || val.startsWith('--')) usage(2);
      opts[key] = val;
    } else positional.push(a);
  }
  return { cmd, positional, opts };
}

function printPlan(plan: Plan) {
  console.log(`\n${plan.kind}  ${plan.service}  (${plan.stage} / ${plan.region})`);
  console.log(`  source  ${plan.source}`);
  if (!plan.resources.length) console.log('  (no supported resources)');
  for (const r of plan.resources) {
    const detail = r.detail ? `  — ${r.detail}` : '';
    console.log(`  ${r.action.padEnd(6)} ${r.kind.padEnd(22)} ${r.name}${detail}`);
  }
  if (plan.placeholders.length) {
    console.log('  secrets (local env file only — values are never printed, never read from real AWS):');
    for (const p of plan.placeholders) {
      const filled = p.filled ?? [];
      const defaulted = p.defaulted ?? [];
      const missing = p.missing ?? p.keys.filter((k) => !filled.includes(k) && !defaulted.includes(k));
      console.log(`    ${p.name}`);
      if (filled.length) console.log(`      from env file: ${filled.join(', ')}`);
      if (defaulted.length) console.log(`      yaml default:   ${defaulted.join(', ')}`);
      if (missing.length) console.log(`      missing:        ${missing.join(', ')}`);
      if (!filled.length && !defaulted.length && !missing.length && p.keys.length) console.log(`      keys: ${p.keys.join(', ')}`);
    }
  }
  for (const w of plan.warnings) console.log(`  warning  ${w}`);
  for (const u of plan.unsupported) console.log(`  skip     ${u}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') usage(0);
  const { cmd, positional, opts } = parseArgs(argv);
  const base = await defaults();
  const common = (): DeployOptions => ({
    source: path.resolve(positional[0] || '.'),
    stage: String(opts.stage || base.stage),
    region: String(opts.region || base.region),
    endpoint: String(opts.endpoint || base.endpoint),
    dryRun: Boolean(opts.dryRun) || cmd === 'plan',
    noBuild: Boolean(opts.noBuild),
    noRun: Boolean(opts.noRun),
    desiredCount: opts['desired-count'] ? Number(opts['desired-count']) : undefined,
    kind: opts.kind === 'serverless' || opts.kind === 'trinity' ? opts.kind : undefined,
    envFile: typeof opts['env-file'] === 'string' ? String(opts['env-file']) : undefined,
  });

  if (cmd === 'list') {
    const all = listManifests();
    if (!all.length) {
      console.log('No deployments recorded in ~/.aws-emulator/deployments.');
      return;
    }
    for (const m of all) {
      console.log(`${m.id}  ${m.kind}  ${m.service}/${m.stage}  ${m.resources.length} resources  updated ${m.updatedAt}`);
    }
    return;
  }

  if (cmd === 'deploy' || cmd === 'plan') {
    if (!positional[0]) usage(2);
    const o = common();
    console.log(`${o.dryRun ? 'Planning' : 'Deploying'} ${o.source} → ${o.endpoint}  (${o.region}, stage ${o.stage})`);
    const result = await deployAll(o);
    if (result.envFile) console.log(`Using env file ${result.envFile} (values not printed)`);
    else console.log('No .env.local or .env found in the target repo (pass --env-file to fill placeholders).');
    for (const p of result.plans) printPlan(p);
    if (!o.dryRun) {
      for (const m of result.manifests) {
        console.log(`\nRecorded deployment ${m.id} (${m.resources.length} resources).`);
        if (m.placeholders.length) {
          console.log('Missing secret keys to fill in (Floci Secrets Manager, or a local --env-file):');
          for (const p of m.placeholders) console.log(`  • ${p.name}${p.keys.length ? ` — ${p.keys.join(', ')}` : ''}`);
        }
      }
    }
    return;
  }

  if (cmd === 'secrets') {
    if (!positional[0]) usage(2);
    const o = common();
    const result = inspectSecrets(o);
    if (result.envFile) console.log(`Env file: ${result.envFile} (values not printed)`);
    else console.log('Env file: none (.env.local / .env not found; pass --env-file)');
    const missingAll: string[] = [];
    for (const p of result.plans) {
      console.log(`\n${p.kind}  ${p.service}  (${p.stage})`);
      if (!p.placeholders.length) console.log('  (no secret / SSM keys referenced)');
      for (const s of p.placeholders) {
        console.log(`  ${s.name}`);
        const filled = new Set(s.filled ?? []);
        const defaulted = new Set(s.defaulted ?? []);
        const keys = s.keys.length ? s.keys : [];
        for (const k of keys) {
          const status = filled.has(k) ? 'present' : defaulted.has(k) ? 'defaulted' : 'missing';
          console.log(`    ${k.padEnd(32)} ${status}`);
          if (status === 'missing') missingAll.push(k);
        }
      }
    }
    if (missingAll.length) console.log(`\nMissing keys: ${[...new Set(missingAll)].join(', ')}`);
    else console.log('\nAll referenced keys are present in the env file or have a YAML default.');
    if (opts['write-example']) {
      const keys = result.plans.flatMap((p) => p.placeholders.flatMap((s) => s.keys));
      const dest = typeof opts['write-example'] === 'string'
        ? path.resolve(String(opts['write-example']))
        : path.join(o.source, '.env.example');
      fs.writeFileSync(dest, renderEnvExample(keys));
      console.log(`Wrote key-names-only template to ${dest}`);
    }
    return;
  }

  if (cmd === 'destroy') {
    if (!positional[0]) usage(2);
    const target = positional[0];
    const o = common();
    // A path: destroy every recorded deploy whose source lives under it. An id: that deploy only.
    const all = listManifests();
    const abs = path.resolve(target);
    const matches = all.filter((m) => m.id === target || m.source === abs || m.source.startsWith(abs + path.sep) || m.id.startsWith(target));
    if (!matches.length) throw new Error(`no recorded deployment matches ${target} (see aws-emulator list)`);
    for (const m of matches) {
      console.log(`Destroying ${m.id} …`);
      const r = await destroyById(o, m.id);
      console.log(`  removed ${r.ok.length}, failed ${r.failed.length}`);
      for (const f of r.failed) console.log(`  ! ${f.name}: ${f.error}`);
    }
    return;
  }

  usage(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
