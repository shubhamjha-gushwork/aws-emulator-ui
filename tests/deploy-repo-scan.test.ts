/**
 * Regression tests for issues found by dry-run planning real-world-shaped serverless.yml / trinity.yml
 * files. All fixtures are synthetic and written to a temp dir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { GetSecretValueCommand, PutSecretValueCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { parseTrinityFile, planTrinity } from '@/lib/deploy/trinity/parse';
import { parseServerlessFile, planServerless } from '@/lib/deploy/serverless/parse';
import { mergeSecretPayload, upsertPlaceholderSecret } from '@/lib/deploy/secrets';
import { splitShared } from '@/lib/deploy/destroy';
import { deployHadFailures } from '@/lib/deploy';
import { PLACEHOLDER_VALUE, type DeployManifest } from '@/lib/deploy/types';

function write(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-scan-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

const ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret';

describe('stage fallback (--fallback-stage) for stage-keyed lookups', () => {
  const yml = `
name: sample-svc
region: us-east-1
environment:
  refs:
    credsdev: ${ARN}:dev/sample-app-AbCdEf
    credsprod: ${ARN}:prod/sample-app-AbCdEf
    otherCreds-prod: ${ARN}:prod/sample-other-AbCdEf
  variables:
    API_TOKEN: \${environment.refs.creds\${custom.stage}.API_TOKEN}
custom:
  dev:
    cpu: 512
  prod:
    cpu: 1024
    desiredCapacity: 3
stacks:
  HTTPApi:
    - name: sample-web
      dockerfile: Dockerfile
      cpu: \${custom.\${custom.stage}.cpu}
      desiredCapacity: \${custom.\${custom.stage}.desiredCapacity}
      environment:
        OTHER_KEY: \${environment.refs.otherCreds-\${custom.stage}.OTHER_KEY}
        WITH_DEFAULT: \${custom.\${custom.stage}.missing, 'explicit'}
        BROKEN: \${environment.refs.nothere.KEY}
`;
  const parse = (fallbackStages?: string[]) => parseTrinityFile(write('trinity.yml', yml), { stage: 'local', region: 'us-east-1', env: {}, fileEnv: {}, fallbackStages });

  it('retries a stage-keyed lookup with the fallback stage (default dev), for custom blocks and refs alike', () => {
    const p = parse();
    const task = p.stacks[0].tasks[0];
    expect(task.environment?.API_TOKEN).toBe('PLACEHOLDER');
    expect(task.cpu).toBe(512);
    const plan = planTrinity(p);
    expect(plan.placeholders.find((s) => s.name === 'aws-emulator/local/dev/sample-app')?.keys).toEqual(['API_TOKEN']);
    expect(plan.warnings).toContain('environment.refs.credslocal is not defined for stage local; using environment.refs.credsdev (fallback stage dev, see --fallback-stage)');
    expect(plan.warnings).toContain('custom.local is not defined for stage local; using custom.dev (fallback stage dev, see --fallback-stage)');
  });

  it('does not guess: a key only another stage defines stays unresolved unless that stage is listed', () => {
    const p = parse();
    expect(p.stacks[0].tasks[0].environment?.OTHER_KEY).toBeUndefined();
    expect(p.stacks[0].tasks[0].desiredCount).toBeUndefined();
    const withProd = parse(['dev', 'prod']);
    expect(withProd.stacks[0].tasks[0].environment?.OTHER_KEY).toBe('PLACEHOLDER');
    expect(withProd.stacks[0].tasks[0].cpu).toBe(512);
    expect(withProd.stacks[0].tasks[0].desiredCount).toBe(3);
  });

  it('can be turned off, and never overrides an explicit default', () => {
    const off = parse([]);
    expect(off.stacks[0].tasks[0].cpu).toBeUndefined();
    expect(off.stacks[0].tasks[0].environment?.API_TOKEN).toBeUndefined();
    expect(parse().stacks[0].tasks[0].environment?.WITH_DEFAULT).toBe('explicit');
  });

  it('applies the same rule to serverless.yml lookups', () => {
    const file = write('serverless.yml', `
service: sample-fb
provider:
  name: aws
  runtime: nodejs20.x
  environment:
    LEVEL: \${self:custom.settings.\${sls:stage}.level}
    SIZE: \${self:custom.settings.\${opt:stage}.size, 'small'}
custom:
  settings:
    dev:
      level: debug
      size: large
`);
    const p = parseServerlessFile(file, { stage: 'qa', region: 'us-east-1', env: {}, fileEnv: {} });
    expect(p.environment.LEVEL).toBe('debug');
    expect(p.environment.SIZE).toBe('small');
    expect(p.warnings.some((w) => w.startsWith('self:custom.settings.qa is not defined for stage qa; using self:custom.settings.dev'))).toBe(true);
    expect(parseServerlessFile(file, { stage: 'qa', region: 'us-east-1', env: {}, fileEnv: {}, fallbackStages: [] }).environment.LEVEL).toBeUndefined();
  });

  it('does not create secrets for refs nothing reads, and says so', () => {
    const plan = planTrinity(parse());
    expect(plan.resources.some((r) => r.kind === 'secret' && r.name === 'aws-emulator/local/prod/sample-app')).toBe(false);
    expect(plan.warnings.some((w) => w.includes('aws-emulator/local/prod/sample-app') && w.includes('not referenced'))).toBe(true);
  });

  it('warns about unresolved bare paths instead of dropping them silently', () => {
    const p = parse();
    expect(p.stacks[0].tasks[0].environment?.BROKEN).toBeUndefined();
    expect(p.warnings.some((w) => w.includes('${environment.refs.nothere.KEY} could not be resolved'))).toBe(true);
  });
});

describe('serverless: SQS trigger sources in the plan', () => {
  const yml = `
service: sample-q
provider:
  name: aws
  runtime: nodejs20.x
custom:
  vars: \${ssm:/aws/reference/secretsmanager/sample-vars}
constructs:
  jobs:
    type: queue
    worker:
      handler: src/worker.handler
resources:
  Resources:
    InboxQueue:
      Type: AWS::SQS::Queue
      Properties:
        QueueName: sample-inbox-\${sls:stage}
functions:
  fromSecret:
    handler: src/a.handler
    events:
      - sqs:
          arn: \${self:custom.vars.QUEUE_ARN}
  fromWholeSecret:
    handler: src/f.handler
    events:
      - sqs:
          arn: \${ssm:/aws/reference/secretsmanager/sample-vars}
  fromDlq:
    handler: src/b.handler
    events:
      - sqs:
          arn: \${construct:jobs.dlqArn}
  fromStack:
    handler: src/c.handler
    events:
      - sqs:
          arn: !GetAtt InboxQueue.Arn
  fromName:
    handler: src/d.handler
    events:
      - sqs:
          arn: sample-inbox-qa
  fromNowhere:
    handler: src/e.handler
    events:
      - sqs:
          arn: some-queue-elsewhere
`;
  const plan = () => planServerless(parseServerlessFile(write('serverless.yml', yml), { stage: 'qa', region: 'us-east-1', env: {}, fileEnv: {} }));

  it('skips (with a warning) triggers whose source apply cannot resolve, instead of planning them', () => {
    const p = plan();
    const esm = p.resources.filter((r) => r.kind === 'event-source-mapping').map((r) => r.name);
    expect(esm.some((n) => n.includes('fromSecret'))).toBe(false);
    expect(esm.some((n) => n.includes('fromNowhere'))).toBe(false);
    expect(esm.some((n) => n.includes('fromWholeSecret'))).toBe(false);
    expect(p.warnings.some((w) => w.startsWith('fromSecret: SQS trigger source comes from a secret'))).toBe(true);
    expect(p.warnings.some((w) => w.startsWith('fromNowhere: SQS trigger source is not an ARN'))).toBe(true);
    expect(p.warnings.join('\n')).not.toContain('some-queue-elsewhere');
  });

  it('shows lift construct, GetAtt and in-stack queue-name sources readably', () => {
    const esm = plan().resources.filter((r) => r.kind === 'event-source-mapping').map((r) => r.name);
    // Lift names queues <service>-<stage>-<id> and the DLQ <queue>-dlq.
    expect(esm.find((n) => n.includes('fromDlq'))).toContain('sample-q-qa-jobs-dlq (lift construct in this stack)');
    expect(esm.find((n) => n.includes('fromDlq'))).not.toContain('__CONSTRUCT__');
    expect(esm.find((n) => n.includes('fromStack'))).toContain('InboxQueue (from this stack)');
    expect(esm.find((n) => n.includes('fromName'))).toContain('sample-inbox-qa (from this stack)');
  });
});

describe('secrets: merge instead of overwrite', () => {
  it('keeps other configs\' keys and hand-filled values; env file wins; missing keys get the placeholder', () => {
    const existing = JSON.stringify({ OTHER_CONFIG_KEY: 'x1', FILLED_BY_HAND: 'x2', STILL_PLACEHOLDER: PLACEHOLDER_VALUE });
    const r = mergeSecretPayload(existing, ['FILLED_BY_HAND', 'FROM_ENV', 'STILL_PLACEHOLDER', 'NEW_KEY'], { FROM_ENV: 'x3' });
    const out = JSON.parse(r.secretString);
    expect(out).toEqual({ OTHER_CONFIG_KEY: 'x1', FILLED_BY_HAND: 'x2', FROM_ENV: 'x3', STILL_PLACEHOLDER: PLACEHOLDER_VALUE, NEW_KEY: PLACEHOLDER_VALUE });
    expect(r.filled).toEqual(['FROM_ENV']);
    expect(r.kept).toEqual(['FILLED_BY_HAND']);
    expect(r.missing).toEqual(['STILL_PLACEHOLDER', 'NEW_KEY']);
  });

  it('keeps a plain-string secret that has no keys', () => {
    expect(mergeSecretPayload('plain-value', [], {}).secretString).toBe('plain-value');
    expect(JSON.parse(mergeSecretPayload(undefined, [], {}).secretString)).toEqual({ VALUE: PLACEHOLDER_VALUE });
  });

  it('creates when missing and puts the merged value when present', async () => {
    const sent: unknown[] = [];
    const fake = (current?: string) => ({
      secrets: {
        send: async (cmd: unknown) => {
          sent.push(cmd);
          if (cmd instanceof GetSecretValueCommand) {
            if (current === undefined) throw Object.assign(new Error('Secrets Manager can\'t find the specified secret.'), { name: 'ResourceNotFoundException' });
            return { SecretString: current };
          }
          return {};
        },
      },
    }) as unknown as Parameters<typeof upsertPlaceholderSecret>[0];
    await upsertPlaceholderSecret(fake(), 'aws-emulator/qa/sample', ['A'], {}, 'd');
    expect(sent.some((c) => c instanceof CreateSecretCommand)).toBe(true);
    sent.length = 0;
    await upsertPlaceholderSecret(fake(JSON.stringify({ B: 'kept' })), 'aws-emulator/qa/sample', ['A'], {}, 'd');
    const put = sent.find((c) => c instanceof PutSecretValueCommand) as PutSecretValueCommand;
    expect(JSON.parse(put.input.SecretString!)).toEqual({ B: 'kept', A: PLACEHOLDER_VALUE });
  });
});

describe('destroy and prune: resources shared with another deployment', () => {
  const m = (id: string, region: string, names: string[]): DeployManifest => ({
    id, kind: 'trinity', service: id, stage: 'qa', region, source: `/tmp/${id}.yml`, createdAt: '', updatedAt: '', placeholders: [], warnings: [],
    resources: names.map((n) => ({ kind: n.startsWith('aws-emulator/') ? 'secret' : 'ecs-cluster', name: n })),
  });

  it('keeps a secret another deployment in the same region also records', () => {
    const a = m('a', 'us-east-1', ['aws-emulator/qa/shared', 'cluster-a']);
    const b = m('b', 'us-east-1', ['aws-emulator/qa/shared']);
    const c = m('c', 'eu-west-1', ['cluster-a']);
    const { own, shared } = splitShared(a.resources, 'a', 'us-east-1', [a, b, c]);
    expect(own.map((r) => r.name)).toEqual(['cluster-a']);
    expect(shared).toEqual([{ resource: a.resources[0], by: 'b' }]);
  });

  it('only failures during the deploy block pruning, not unresolved-variable notes from parsing', () => {
    const parse = ['${self:custom.x.qa} could not be resolved (no value and no default)'];
    expect(deployHadFailures([...parse], parse)).toBe(false);
    expect(deployHadFailures([...parse, 'fn: create failed: boom'], parse)).toBe(true);
  });
});
