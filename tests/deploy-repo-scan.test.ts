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

describe('trinity: stage-keyed environment.refs', () => {
  const yml = `
name: sample-svc
region: us-east-1
environment:
  refs:
    secretsdev: ${ARN}:dev/sample-app-*
    secretsprod: ${ARN}:prod/sample-app-*
    jobSecrets-prod: ${ARN}:prod/sample-jobs-AbCdEf
  variables:
    API_TOKEN: \${environment.refs.secrets\${custom.stage}.API_TOKEN}
custom:
  dev:
    cpu: 512
  prod:
    cpu: 1024
stacks:
  HTTPApi:
    - name: sample-web
      dockerfile: Dockerfile
      cpu: \${custom.\${custom.stage}.cpu}
      environment:
        JOB_KEY: \${environment.refs.jobSecrets-\${custom.stage}.JOB_KEY}
        BROKEN: \${environment.refs.nothere.KEY}
`;
  const parse = () => parseTrinityFile(write('trinity.yml', yml), { stage: 'local', region: 'us-east-1', env: {}, fileEnv: {} });

  it('falls back to the dev ref (like custom.dev) instead of silently dropping env vars', () => {
    const p = parse();
    const task = p.stacks[0].tasks[0];
    expect(task.environment?.API_TOKEN).toBe('PLACEHOLDER');
    expect(task.cpu).toBe(512);
    const plan = planTrinity(p);
    const dev = plan.placeholders.find((s) => s.name === 'aws-emulator/local/dev/sample-app');
    expect(dev?.keys).toEqual(['API_TOKEN']);
    expect(plan.warnings.some((w) => w.includes('environment.refs.secretslocal') && w.includes('secretsdev'))).toBe(true);
  });

  it('uses the only stage ref there is when no dev ref exists', () => {
    const p = parse();
    expect(p.stacks[0].tasks[0].environment?.JOB_KEY).toBe('PLACEHOLDER');
    expect(planTrinity(p).placeholders.find((s) => s.name === 'aws-emulator/local/prod/sample-jobs')?.keys).toEqual(['JOB_KEY']);
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

describe('trinity: prod-only custom block', () => {
  it('uses the only stage block when there is no dev block, with a warning', () => {
    const file = write('trinity.yml', `
name: sample-mon
custom:
  prod:
    cpu: 1024
    desiredCapacity: 3
stacks:
  Fargate:
    - clusterName: sample-mon
      tasks:
        - name: sample-task
          dockerfile: Dockerfile
          cpu: \${custom.\${custom.stage}.cpu}
          desiredCapacity: \${custom.\${custom.stage}.desiredCapacity}
`);
    const p = parseTrinityFile(file, { stage: 'local', region: 'us-east-1', env: {}, fileEnv: {} });
    expect(p.stacks[0].tasks[0].cpu).toBe(1024);
    expect(p.stacks[0].tasks[0].desiredCount).toBe(3);
    expect(p.warnings).toContain('custom.local is not defined; using custom.prod for stage local');
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
    expect(esm.find((n) => n.includes('fromDlq'))).toContain('jobs-qa-dlq (lift construct in this stack)');
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
