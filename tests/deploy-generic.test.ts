/**
 * General rules the deploy CLI follows (Serverless Framework variable syntax, AWS ARN formats and
 * naming limits, ECS upsert). Neutral fixtures only.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { CreateServiceCommand, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { createCtx, interpolateString, interpolateTree, secretNameFromArn } from '@/lib/deploy/interpolate';
import { fitGeneratedName, invalidName, NAME_RULES } from '@/lib/deploy/cfn';
import { EMULATED_PLUGINS, parseServerlessFile, planServerless, pluginNames } from '@/lib/deploy/serverless/parse';
import { parseClusterArn, upsertService } from '@/lib/deploy/trinity/apply';

const ctxFor = (root: Record<string, unknown>, extra: Partial<Parameters<typeof createCtx>[0]> = {}) =>
  createCtx({ stage: 'qa', region: 'us-east-1', root, fileBase: os.tmpdir(), env: { SET_VAR: 'from-env' }, ...extra });

describe('variable fallbacks (Serverless Framework syntax)', () => {
  it('tries each comma-separated fallback in order; quoted strings, numbers and booleans are literals', () => {
    const c = ctxFor({ custom: { b: 'from-self' } });
    expect(interpolateString("${env:NOPE, env:SET_VAR, 'lit'}", c)).toBe('from-env');
    expect(interpolateString("${env:NOPE, env:ALSO_NOPE, 'lit'}", c)).toBe('lit');
    expect(interpolateString('${env:NOPE, self:custom.b}', c)).toBe('from-self');
    expect(interpolateString('${env:NOPE, 42}', c)).toBe('42');
    expect(interpolateString('${env:NOPE, true}', c)).toBe('true');
    expect(interpolateString("${env:NOPE, ''}", c)).toBe('');
    expect(interpolateString("${env:NOPE, 'a, b'}", c)).toBe('a, b');
  });

  it('resolves a fallback that is a variable with its own fallback', () => {
    const c = ctxFor({ custom: {} });
    expect(interpolateString("${self:custom.x, ${env:NOPE, 'deep'}}", c)).toBe('deep');
  });

  it('treats ${x:-default} as shell syntax only in trinity files', () => {
    const doc = { custom: { a: 'set' } };
    expect(interpolateString('${custom.missing:-fallback}', ctxFor(doc, { dialect: 'trinity' }))).toBe('fallback');
    expect(interpolateString('${custom.a:-fallback}', ctxFor(doc, { dialect: 'trinity' }))).toBe('set');
    expect(interpolateString('${env:NOPE:-x}', ctxFor(doc))).not.toBe('x');
  });

  it('retries any stage-keyed lookup with the fallback stages, in order, and only when there is no explicit default', () => {
    const doc = { custom: { sizes: { dev: 'm', staging: 's' }, onlyStaging: { staging: 'z' } } };
    expect(interpolateString('${self:custom.sizes.${sls:stage}}', ctxFor(doc))).toBe('m');
    expect(interpolateString('${self:custom.onlyStaging.${sls:stage}}', ctxFor(doc, { fallbackStages: ['dev', 'staging'] }))).toBe('z');
    expect(interpolateString('${self:custom.sizes.${sls:stage}}', ctxFor(doc, { fallbackStages: [] }))).toBeUndefined();
    expect(interpolateString("${self:custom.sizes.${sls:stage}, 'own'}", ctxFor(doc))).toBe('own');
    // A literal path is not stage-keyed.
    expect(interpolateString('${self:custom.sizes.qa}', ctxFor(doc))).toBeUndefined();
  });

  it('uses --stage for the service stage, not custom.stage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sls-stage-'));
    fs.writeFileSync(path.join(dir, 'serverless.yml'), "service: s\nprovider:\n  name: aws\ncustom:\n  stage: other\nfunctions:\n  f:\n    handler: h.handler\n");
    const p = parseServerlessFile(path.join(dir, 'serverless.yml'), { stage: 'qa', region: 'us-east-1', env: {} });
    expect(p.stage).toBe('qa');
    expect(p.functions[0].deployedName).toBe('s-qa-f');
  });

  it('keeps forward references and nested values working across a whole document', () => {
    const doc = { a: '${self:b}-x', b: '${self:c}', c: 'v' };
    interpolateTree(doc, ctxFor(doc));
    expect(doc.a).toBe('v-x');
  });
});

describe('Secrets Manager ARNs (AWS format)', () => {
  const base = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:';
  it('drops the 6-character random suffix of a full ARN and keeps a partial ARN as is', () => {
    expect(secretNameFromArn(`${base}team/app-AbC123`)).toBe('team/app');
    expect(secretNameFromArn(`${base}team/app`)).toBe('team/app');
    expect(secretNameFromArn(`${base}team/app-12345`)).toBe('team/app-12345');
    expect(secretNameFromArn(`${base}team/app-1234567`)).toBe('team/app-1234567');
  });
  it('handles IAM wildcards, other partitions and ECS valueFrom suffixes', () => {
    expect(secretNameFromArn(`${base}team/app-??????`)).toBe('team/app');
    expect(secretNameFromArn(`${base}team/app-*`)).toBe('team/app');
    expect(secretNameFromArn('arn:aws-cn:secretsmanager:cn-north-1:000000000000:secret:x-AbCdEf')).toBe('x');
    expect(secretNameFromArn(`${base}team/app-AbC123:KEY::`)).toBe('team/app');
    expect(secretNameFromArn('arn:aws:sqs:us-east-1:000000000000:q')).toBeUndefined();
  });
});

describe('AWS naming rules', () => {
  it('validates names against each service limit and character set', () => {
    expect(invalidName('lambda', 'a'.repeat(64))).toBeUndefined();
    expect(invalidName('lambda', 'a'.repeat(65))).toContain('Lambda limit 64');
    expect(invalidName('sqs', 'q.fifo')).toBeUndefined();
    expect(invalidName('sqs', 'bad name')).toContain('does not allow');
    expect(invalidName('s3', 'ab')).toContain('shorter than 3');
    expect(invalidName('s3', 'Upper')).toContain('does not allow');
    expect(invalidName('sfn', 'has space')).toContain('does not allow');
    expect(invalidName('ecr', 'team/app')).toBeUndefined();
  });
  it('fits generated names into every limit, deterministically', () => {
    for (const kind of Object.keys(NAME_RULES) as (keyof typeof NAME_RULES)[]) {
      const long = `x${'-y'.repeat(400)}`;
      const fitted = fitGeneratedName(kind, long);
      expect(fitted.length).toBeLessThanOrEqual(NAME_RULES[kind].max);
      expect(fitGeneratedName(kind, long)).toBe(fitted);
    }
  });
});

describe('plugins', () => {
  it('accepts the list and the { modules } form, and reports every plugin it does not emulate', () => {
    expect(pluginNames(['a', 'b'])).toEqual(['a', 'b']);
    expect(pluginNames({ localPath: './p', modules: ['c'] })).toEqual(['c']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sls-plugins-'));
    fs.writeFileSync(path.join(dir, 'serverless.yml'), `service: s\nprovider:\n  name: aws\nplugins:\n  modules:\n    - ${Object.keys(EMULATED_PLUGINS)[0]}\n    - some-other-plugin\n`);
    const plan = planServerless(parseServerlessFile(path.join(dir, 'serverless.yml'), { stage: 'qa', region: 'us-east-1', env: {} }));
    expect(plan.unsupported).toContain('plugin some-other-plugin is not run; its effects are not emulated');
    expect(plan.unsupported.some((u) => u.includes(Object.keys(EMULATED_PLUGINS)[0]))).toBe(false);
  });
});

describe('ECS service upsert', () => {
  const fake = (described: object[], fail: { update?: string; create?: string }) => {
    const sent: string[] = [];
    return {
      sent,
      client: {
        ecs: {
          send: async (cmd: unknown) => {
            if (cmd instanceof DescribeServicesCommand) return { services: described };
            if (cmd instanceof UpdateServiceCommand) { sent.push('update'); if (fail.update) throw Object.assign(new Error(fail.update), { name: fail.update }); return {}; }
            if (cmd instanceof CreateServiceCommand) { sent.push('create'); if (fail.create) throw Object.assign(new Error(fail.create), { name: fail.create }); return {}; }
            return {};
          },
        },
      } as unknown as Parameters<typeof upsertService>[0],
    };
  };
  const args = { cluster: 'c1', region: 'us-east-1', serviceName: 'web', update: { service: 'web' }, create: { serviceName: 'web' } };
  const here = { serviceName: 'web', status: 'ACTIVE', clusterArn: 'arn:aws:ecs:us-east-1:000000000000:cluster/c1' };
  const elsewhere = { ...here, clusterArn: 'arn:aws:ecs:eu-west-1:000000000000:cluster/c1' };

  it('updates a service in this cluster and region, creates otherwise', async () => {
    const a = fake([here], {});
    expect(await upsertService(a.client, args)).toBe('updated');
    const b = fake([elsewhere], {});
    expect(await upsertService(b.client, args)).toBe('created');
  });

  it('retries as create when update says the service is missing, and as update when create says it exists', async () => {
    const a = fake([here], { update: 'ServiceNotFoundException' });
    expect(await upsertService(a.client, args)).toBe('created');
    expect(a.sent).toEqual(['update', 'create']);
    const b = fake([], { create: 'InvalidParameterException: Creation of service was not idempotent' });
    expect(await upsertService(b.client, args)).toBe('updated');
    expect(b.sent).toEqual(['create', 'update']);
    await expect(upsertService(fake([], { create: 'AccessDeniedException' }).client, args)).rejects.toThrow('AccessDenied');
  });

  it('parses cluster ARNs', () => {
    expect(parseClusterArn('arn:aws:ecs:eu-west-1:000000000000:cluster/web-a')).toEqual({ region: 'eu-west-1', cluster: 'web-a' });
    expect(parseClusterArn('not-an-arn')).toBeUndefined();
  });
});

describe('secret keys with fallbacks', () => {
  it('counts a key as defaulted only when a fallback supplies a value', async () => {
    const { SecretBag, collectSecrets } = await import('@/lib/deploy/interpolate');
    const doc: Record<string, unknown> = {
      custom: { s: '${ssm:/aws/reference/secretsmanager/sample}' },
      a: "${self:custom.s.LIT, 'x'}",
      b: '${self:custom.s.FROM_ENV, env:SET_VAR}',
      c: '${self:custom.s.NOWHERE, env:UNSET_VAR}',
    };
    const c = ctxFor(doc);
    interpolateTree(doc, c);
    expect((doc.custom as { s: unknown }).s).toBeInstanceOf(SecretBag);
    expect(doc.a).toBe('x');
    expect(doc.b).toBe('from-env');
    expect(doc.c).toBe('PLACEHOLDER');
    expect(collectSecrets(c)[0].defaulted).toEqual(['FROM_ENV', 'LIT']);
  });
});
