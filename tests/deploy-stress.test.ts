/**
 * Regression tests for bugs found by stress-testing the deploy CLI with many serverless.yml /
 * trinity.yml shapes. Each block names the bug it guards against.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCtx, interpolateString, interpolateTree, SecretBag, PLACEHOLDER } from '@/lib/deploy/interpolate';
import { fitName, orderByDependencies, referencedIds, resolveIntrinsic, decodeIntrinsic } from '@/lib/deploy/cfn';
import { normalizeLogical, parseServerlessFile, planServerless, strEnv, httpRouteKey, restMethod } from '@/lib/deploy/serverless/parse';
import { matchesPackagePatterns, globMatch } from '@/lib/deploy/serverless/package';
import { parseTrinityFile, planTrinity, trinityNames } from '@/lib/deploy/trinity/parse';
import { sameServiceHome } from '@/lib/deploy/trinity/apply';
import { parseEnvContent } from '@/lib/deploy/envfile';
import { loadYaml } from '@/lib/deploy/yaml';
import { dedupeResources, resourceKey } from '@/lib/deploy/destroy';
import { matchDeployments } from '@/lib/deploy/match';
import { resolveManifestId } from '@/lib/deploy';
import { writeManifest } from '@/lib/deploy/state';
import { isConnectionError } from '@/lib/deploy/client';
import { detectConfigs } from '@/lib/deploy/detect';
import type { DeployManifest } from '@/lib/deploy/types';

const fixtures = path.join(__dirname, 'fixtures');
const repo = path.resolve(__dirname, '..');

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('variable resolution (serverless)', () => {
  const ctxFor = (root: Record<string, unknown>) => createCtx({ stage: 'qa', region: 'us-east-1', root, fileBase: fixtures, env: {} });

  it('resolves ${sls:stage} (was dropped silently)', () => {
    expect(interpolateString('${sls:stage}', ctxFor({}))).toBe('qa');
    expect(interpolateString('svc-${sls:stage}', ctxFor({}))).toBe('svc-qa');
  });

  it('resolves forward references to values not walked yet', () => {
    const doc = { provider: { name: '${self:custom.full}' }, custom: { full: 'late-${opt:stage}' } };
    interpolateTree(doc, ctxFor(doc));
    expect(doc.provider.name).toBe('late-qa');
  });

  it('survives circular references with a warning instead of a stack overflow', () => {
    const doc = { custom: { a: '${self:custom.b}', b: '${self:custom.a}', m: 'pre-${self:custom.n}', n: 'mid-${self:custom.m}' } };
    const ctx = ctxFor(doc);
    expect(() => interpolateTree(doc, ctx)).not.toThrow();
    expect(ctx.warnings.some((w) => w.includes('circular reference'))).toBe(true);
    expect(String(doc.custom.n).length).toBeLessThan(80);
  });

  it('warns on a missing ${self:} with no default, and nested fallbacks still win', () => {
    const doc = { custom: { x: '${self:custom.nope}', y: "${self:custom.nope, ${env:SAMPLE_UNSET, 'c'}}" } };
    const ctx = ctxFor(doc);
    interpolateTree(doc, ctx);
    expect(doc.custom.y).toBe('c');
    expect(ctx.warnings.some((w) => w.includes('${self:custom.nope} could not be resolved'))).toBe(true);
  });

  it('leaves CloudFormation ${AWS::Region} and Fn::Sub logical refs alone', () => {
    const doc = { r: { 'Fn::Sub': '${AWS::Region}-${MyQueue.Arn}-${self:custom.s}' }, custom: { s: 'v' }, plain: '${AWS::AccountId}' };
    interpolateTree(doc, ctxFor(doc));
    expect(doc.r['Fn::Sub']).toBe('${AWS::Region}-${MyQueue.Arn}-v');
    expect(doc.plain).toBe('${AWS::AccountId}');
  });

  it('keeps env vars that are secrets, intrinsics, numbers or booleans (were dropped)', () => {
    const env = strEnv({ A: new SecretBag('x', 'ssm'), B: { Ref: 'Q' }, C: 42, D: true, E: null });
    expect(env.A).toBe(PLACEHOLDER);
    expect(decodeIntrinsic(env.B)).toEqual({ Ref: 'Q' });
    expect(env.C).toBe('42');
    expect(env.D).toBe('true');
    expect('E' in env).toBe(false);
  });
});

describe('CloudFormation intrinsics', () => {
  const logical = {
    Q: { name: 'q1', url: 'http://h/000000000000/q1', arn: 'arn:aws:sqs:us-east-1:000000000000:q1', kind: 'sqs' },
    T: { name: 't1', arn: 'arn:aws:sns:us-east-1:000000000000:t1', kind: 'sns' },
  };
  const p = { region: 'eu-west-1', stackName: 'svc-qa' };

  it('resolves Ref, GetAtt, Join, Sub, Select and Split', () => {
    expect(resolveIntrinsic({ Ref: 'Q' }, logical, p)).toBe('http://h/000000000000/q1');
    expect(resolveIntrinsic({ Ref: 'T' }, logical, p)).toBe('arn:aws:sns:us-east-1:000000000000:t1');
    expect(resolveIntrinsic({ 'Fn::GetAtt': ['Q', 'Arn'] }, logical, p)).toBe(logical.Q.arn);
    expect(resolveIntrinsic({ 'Fn::Join': ['-', ['a', { Ref: 'AWS::Region' }]] }, logical, p)).toBe('a-eu-west-1');
    expect(resolveIntrinsic({ 'Fn::Sub': '${AWS::StackName}/${Q.QueueName}/${!Literal}' }, logical, p)).toBe('svc-qa/q1/${Literal}');
    expect(resolveIntrinsic({ 'Fn::Sub': ['${X}-y', { X: { Ref: 'AWS::AccountId' } }] }, logical, p)).toBe('000000000000-y');
    expect(resolveIntrinsic({ 'Fn::Select': [1, { 'Fn::Split': [',', 'a,b,c'] }] }, logical, p)).toBe('b');
    expect(resolveIntrinsic({ Ref: 'Missing' }, logical, p)).toBeUndefined();
    expect(resolveIntrinsic({ 'Fn::ImportValue': 'x' }, logical, p)).toBeUndefined();
  });

  it('orders resources so a dead-letter queue is created before the queue that points at it', () => {
    const entries: [string, { Properties?: unknown }][] = [
      ['Main', { Properties: { RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Dlq', 'Arn'] } } } }],
      ['Dlq', { Properties: { QueueName: { 'Fn::Sub': '${Base}-dlq' } } }],
      ['Base', { Properties: {} }],
    ];
    const order = orderByDependencies(entries, (b) => referencedIds(b.Properties)).map(([id]) => id);
    expect(order.indexOf('Dlq')).toBeLessThan(order.indexOf('Main'));
    expect(order.indexOf('Base')).toBeLessThan(order.indexOf('Dlq'));
  });

  it('fits generated names into AWS limits without a trailing hyphen', () => {
    const long = `${'a'.repeat(30)}-${'b'.repeat(40)}-schedule`;
    const fitted = fitName(long, 64);
    expect(fitted.length).toBeLessThanOrEqual(64);
    expect(fitted).toMatch(/[a-z0-9]$/);
    expect(fitName(long, 64)).toBe(fitted);
    expect(fitName('short', 64)).toBe('short');
  });
});

describe('serverless plan for many event types (fixtures/sample-events)', () => {
  const parsed = () => parseServerlessFile(path.join(fixtures, 'sample-events', 'serverless.yml'), { stage: 'qa', region: 'us-east-1', env: {} });

  it('resolves Join/Sub queue names and FIFO names instead of [object Object]', () => {
    const names = planServerless(parsed()).resources.filter((r) => r.kind === 'sqs').map((r) => r.name);
    expect(names).toContain('sample-events-work-qa');
    expect(names).toContain('sample-events-dlq-us-east-1');
    expect(names).toContain('sample-events-ordered.fifo');
    expect(names.join(' ')).not.toContain('[object Object]');
  });

  it('gives each schedule / eventBridge rule its own name and honours rate lists and enabled: false', () => {
    const plan = planServerless(parsed());
    const rules = plan.resources.filter((r) => r.kind === 'event-rule');
    const names = rules.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('sample-events-qa-worker-schedule-4');
    expect(names).toContain('sample-events-qa-worker-eb-2');
    expect(rules.find((r) => r.name.endsWith('schedule-3'))?.detail).toContain('DISABLED');
  });

  it('plans SNS topics by name, HTTP API catch-all and ANY routes', () => {
    const plan = planServerless(parsed());
    expect(plan.resources.filter((r) => r.kind === 'sns').map((r) => r.name)).toContain('sample-events-topic-qa');
    expect(plan.resources.some((r) => r.kind === 'sns' && r.name.includes('[object'))).toBe(false);
    expect(plan.resources.some((r) => r.kind === 'apigatewayv2' && r.detail === '$default')).toBe(true);
    expect(plan.resources.some((r) => r.kind === 'apigateway' && r.detail === 'ANY /any')).toBe(true);
    expect(httpRouteKey('*', '/')).toBe('$default');
    expect(restMethod('*')).toBe('ANY');
  });

  it('warns about unsupported events and too-long names instead of failing', () => {
    const plan = planServerless(parsed());
    for (const ev of ['websocket', 'alb', 'cloudwatchLog', 'stream']) expect(plan.unsupported.some((u) => u.includes(`"${ev}"`))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('Lambda limit 64'))).toBe(true);
    expect(plan.resources.some((r) => r.kind === 'lambda' && r.name.length > 64)).toBe(false);
  });

  it('keeps Ref / GetAtt env vars for deploy time', () => {
    const fn = parsed().functions.find((f) => f.name === 'worker')!;
    expect(decodeIntrinsic(fn.environment!.QUEUE_URL)).toEqual({ Ref: 'WorkQueue' });
  });

  it('uses Serverless logical ids (hello → HelloLambdaFunction)', () => {
    expect(normalizeLogical('hello')).toBe('Hello');
    expect(normalizeLogical('my-fn_x')).toBe('MyDashfnUnderscorex');
  });

  it('--region overrides provider.region; otherwise provider.region wins', () => {
    const dir = tmpDir('sls-region-');
    fs.writeFileSync(path.join(dir, 'serverless.yml'), 'service: r\nprovider:\n  name: aws\n  region: us-west-2\n');
    expect(parseServerlessFile(path.join(dir, 'serverless.yml'), { stage: 'qa', region: 'us-east-1' }).region).toBe('us-west-2');
    expect(parseServerlessFile(path.join(dir, 'serverless.yml'), { stage: 'qa', region: 'eu-west-1', regionFromFlag: true }).region).toBe('eu-west-1');
  });
});

describe('package.patterns', () => {
  it('applies patterns in order so "!**" then "**/*.py" packs root and nested .py files', () => {
    const pats = ['!**', '**/*.py', '!tests/**'];
    expect(globMatch('handler.py', '**/*.py')).toBe(true);
    expect(matchesPackagePatterns('handler.py', pats)).toBe(true);
    expect(matchesPackagePatterns('app/jobs.py', pats)).toBe(true);
    expect(matchesPackagePatterns('tests/test_a.py', pats)).toBe(false);
    expect(matchesPackagePatterns('docs/readme.md', pats)).toBe(false);
  });
});

describe('env file parsing', () => {
  it('handles multi-line quoted values, comments after quotes, BOM, CRLF, export with a tab and backticks', () => {
    const env = parseEnvContent('\uFEFFexport\tA="x # y" # note\r\nPEM="-----BEGIN-----\nab==\ncd=\n-----END-----"\nB=`tick`\nC=plain # c\nD="unterminated\nE=after\n');
    expect(env.A).toBe('x # y');
    expect(env.PEM).toBe('-----BEGIN-----\nab==\ncd=\n-----END-----');
    expect(env.B).toBe('tick');
    expect(env.C).toBe('plain');
    expect(env.D).toBe('"unterminated');
    expect(env.E).toBe('after');
    expect(Object.keys(env).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'PEM']);
  });
});

describe('YAML errors', () => {
  it('are one line with a position, and multi-document files get a clear message', () => {
    expect(() => loadYaml('a:\n  b: [x\n', 'serverless.yml')).toThrow(/^invalid YAML in serverless.yml \(line \d+, column \d+\): [^\n]+$/);
    expect(() => loadYaml('a: 1\n---\nb: 2\n', 'serverless.yml')).toThrow(/several YAML documents/);
  });
});

describe('trinity', () => {
  const parsed = () => parseTrinityFile(path.join(fixtures, 'sample-multi', 'trinity.yml'), { stage: 'qa', region: 'us-east-1', env: {}, fileEnv: {} });

  it('plans the same physical names apply creates (ALB, target group, schedule rule, fitted cpu/memory)', () => {
    const p = parsed();
    const plan = planTrinity(p);
    const web = p.stacks.flatMap((s) => s.tasks).find((t) => t.name === 'sample-web')!;
    const n = trinityNames(p.name, p.stage, web);
    expect(plan.resources.find((r) => r.kind === 'alb')?.name).toBe(n.alb);
    expect(plan.resources.find((r) => r.kind === 'target-group')?.name).toBe(n.targetGroup);
    expect(plan.resources.find((r) => r.kind === 'scheduler')?.name).toBe('sample-cron-qa-schedule');
    expect(plan.resources.find((r) => r.name === 'sample-web-qa')?.detail).toContain('cpu 512 / mem 2048');
    for (const r of plan.resources.filter((x) => x.kind === 'alb' || x.kind === 'target-group')) expect(r.name.length).toBeLessThanOrEqual(32);
    expect(plan.resources.filter((r) => r.kind === 'ecs-cluster').length).toBe(new Set(plan.resources.filter((r) => r.kind === 'ecs-cluster').map((r) => r.name)).size);
  });

  it('strips the random suffix from Secrets Manager ARNs', () => {
    expect(planTrinity(parsed()).placeholders.map((x) => x.name)).toContain('aws-emulator/qa/sample-global-secrets');
  });

  it('reads build args and skips unknown stack types without a Dockerfile', () => {
    const p = parsed();
    expect(p.stacks.flatMap((s) => s.tasks).find((t) => t.name === 'sample-web')?.buildArgs).toEqual({ BUILD_LABEL: 'from-yaml' });
    expect(p.stacks.flatMap((s) => s.tasks).some((t) => t.name === 'sample-unknown')).toBe(false);
    expect(p.unsupported.some((u) => u.includes('stack type Lambda'))).toBe(true);
  });

  it('only treats a described ECS service as present when it is in this cluster and region (Floci matches by name)', () => {
    const svc = { serviceName: 'web', status: 'ACTIVE', clusterArn: 'arn:aws:ecs:eu-west-1:000000000000:cluster/web-a' };
    expect(sameServiceHome(svc, 'web', 'web-a', 'eu-west-1')).toBe(true);
    expect(sameServiceHome(svc, 'web', 'web-b', 'us-east-1')).toBe(false);
    expect(sameServiceHome(svc, 'web', 'web-a', 'us-east-1')).toBe(false);
  });
});

describe('manifests, destroy matching and redeploys', () => {
  let dir: string;
  const prev = process.env.AWS_EMULATOR_DEPLOYMENTS_DIR;
  beforeEach(() => {
    dir = tmpDir('deployments-');
    process.env.AWS_EMULATOR_DEPLOYMENTS_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AWS_EMULATOR_DEPLOYMENTS_DIR;
    else process.env.AWS_EMULATOR_DEPLOYMENTS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (over: Partial<DeployManifest>): DeployManifest => ({
    id: 'svc-a-serverless-serverless.yml', kind: 'serverless', service: 'svc', stage: 'a', region: 'us-east-1', source: '/x/serverless.yml',
    createdAt: '', updatedAt: '', resources: [], placeholders: [], warnings: [], ...over,
  });

  it('reuses one manifest per config file whether addressed by dir, file or symlink, and adds non-default regions to new ids', () => {
    const repoDir = tmpDir('svc-');
    const file = path.join(repoDir, 'serverless.yml');
    fs.writeFileSync(file, 'service: svc\n');
    const link = `${repoDir}-link`;
    fs.symlinkSync(repoDir, link);
    const id = resolveManifestId('serverless', 'svc', 'a', 'us-east-1', file, repoDir);
    writeManifest(manifest({ id, source: file }));
    expect(resolveManifestId('serverless', 'svc', 'a', 'us-east-1', file, file)).toBe(id);
    expect(resolveManifestId('serverless', 'svc', 'a', 'us-east-1', path.join(link, 'serverless.yml'), link)).toBe(id);
    expect(resolveManifestId('serverless', 'svc', 'a', 'eu-west-1', file, repoDir)).toBe(`${id}-eu-west-1`);
    expect(resolveManifestId('serverless', 'svc', 'b', 'us-east-1', file, repoDir)).not.toBe(id);
    fs.unlinkSync(link);
  });

  it('destroy . --stage a leaves stage b alone; ambiguous id prefixes are refused; a path with nothing recorded is a no-op', () => {
    const repoDir = tmpDir('svc-');
    const src = path.join(repoDir, 'serverless.yml');
    fs.writeFileSync(src, 'service: svc\n');
    const all = [manifest({ id: 'svc-a', stage: 'a', source: src }), manifest({ id: 'svc-b', stage: 'b', source: src })];
    expect(matchDeployments(all, repoDir, { stage: 'a' }).map((m) => m.id)).toEqual(['svc-a']);
    expect(matchDeployments(all, repoDir).length).toBe(2);
    expect(() => matchDeployments(all, 'svc-')).toThrow(/matches 2 deployments/);
    expect(matchDeployments(all, 'svc-b').map((m) => m.id)).toEqual(['svc-b']);
    expect(() => matchDeployments(all, `missing-${Date.now()}`)).toThrow(/no recorded deployment/);
    expect(matchDeployments(all, tmpDir('empty-')).length).toBe(0);
  });

  it('dedupes manifest entries; SQS mappings keep one entry per source queue', () => {
    const list = dedupeResources([
      { kind: 'ecs-cluster', name: 'c' }, { kind: 'ecs-cluster', name: 'c' },
      { kind: 'event-source-mapping', name: 'fn', arn: 'arn:q1' }, { kind: 'event-source-mapping', name: 'fn', arn: 'arn:q2' },
      { kind: 'event-rule', name: 'r', extra: { bus: 'b' } },
    ]);
    expect(list.map(resourceKey)).toEqual(['ecs-cluster:c', 'event-source-mapping:fn:arn:q1', 'event-source-mapping:fn:arn:q2', 'event-rule:r@b']);
  });
});

describe('config detection', () => {
  it('finds a symlinked serverless.yml', () => {
    const d = tmpDir('detect-');
    fs.symlinkSync(path.join(fixtures, 'sample-api', 'serverless.yml'), path.join(d, 'serverless.yml'));
    expect(detectConfigs(d).map((c) => c.kind)).toEqual(['serverless']);
  });
});

describe('connection errors', () => {
  it('recognises an unreachable endpoint so per-resource catches do not swallow it', () => {
    expect(isConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isConnectionError({ message: 'socket hang up' })).toBe(true);
    expect(isConnectionError({ name: 'ResourceNotFoundException', message: 'nope' })).toBe(false);
  });
});

describe('CLI argument handling', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--', path.join(repo, 'bin', 'aws-emulator'), ...args], { encoding: 'utf8', env: { ...process.env, AWS_EMULATOR_DEPLOYMENTS_DIR: tmpDir('cli-') } });

  it('rejects an unknown --kind, unknown flags and a non-numeric --desired-count with exit 2', () => {
    for (const args of [['plan', '.', '--kind', 'lambda'], ['plan', '.', '--stagee', 'x'], ['deploy', '.', '--desired-count', 'abc']]) {
      const r = cli(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^✗ /);
    }
  });

  it('reports a missing --env-file itself instead of Node exiting with "node: … not found"', () => {
    const r = cli('plan', path.join(fixtures, 'sample-api'), '--env-file', '/definitely/missing.env');
    expect(r.stderr).toContain('env file not found');
    expect(r.stderr).not.toMatch(/^node:/m);
  });
});
