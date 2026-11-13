#!/usr/bin/env node
import path from 'path';
import { loadSettings } from '../lib/settings';
import { deployAll, destroyById, listManifests, type DeployOptions } from '../lib/deploy';
import type { Plan } from '../lib/deploy/types';

function usage(code = 0): never {
  const text = `aws-emulator — deploy serverless.yml / trinity.yml to local Floci

Usage:
  aws-emulator deploy <path-to-repo-or-file> [options]
  aws-emulator destroy <path-or-deployment-id> [options]
  aws-emulator list
  aws-emulator plan <path>             (alias for deploy --dry-run)

Options:
  --stage <name>         Stage (default: local)
  --region <region>      Region (default: us-east-1, or the UI setting)
  --endpoint <url>       Floci endpoint (default: http://127.0.0.1:4566)
  --dry-run              Print the plan; do not create anything
  --no-build             Skip docker build/push (Trinity)
  --desired-count <n>    Override ECS desiredCount (Trinity services)
  --kind serverless|trinity
                         Only configs of this kind when a directory has both

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
    else if (a.startsWith('--')) {
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
    console.log('  placeholders (Secrets Manager, fill these in — never read from real AWS):');
    for (const p of plan.placeholders) {
      console.log(`    ${p.name}${p.keys.length ? `  keys: ${p.keys.join(', ')}` : ''}`);
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
    desiredCount: opts['desired-count'] ? Number(opts['desired-count']) : undefined,
    kind: opts.kind === 'serverless' || opts.kind === 'trinity' ? opts.kind : undefined,
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
    for (const p of result.plans) printPlan(p);
    if (!o.dryRun) {
      for (const m of result.manifests) {
        console.log(`\nRecorded deployment ${m.id} (${m.resources.length} resources).`);
        if (m.placeholders.length) {
          console.log('Placeholder secrets to fill in (Floci Secrets Manager, or the Secrets page in the UI):');
          for (const p of m.placeholders) console.log(`  • ${p.name}${p.keys.length ? ` — ${p.keys.join(', ')}` : ''}`);
        }
      }
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
