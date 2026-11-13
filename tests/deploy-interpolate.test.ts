import { describe, expect, it } from 'vitest';
import path from 'path';
import { createCtx, interpolateString, interpolateTree, collectSecrets, SecretBag } from '../src/lib/deploy/interpolate';
import { detectConfigs } from '../src/lib/deploy/detect';
import { parseServerlessFile, planServerless } from '../src/lib/deploy/serverless/parse';
import { parseTrinityFile, planTrinity } from '../src/lib/deploy/trinity/parse';

const fixtures = path.join(__dirname, 'fixtures');

describe('interpolate', () => {
  const root = {
    custom: { stage: 'local', dev: { cpu: 256 }, local: { cpu: 128 } },
    provider: { region: 'us-east-1' },
  };
  const ctx = () => createCtx({ stage: 'local', region: 'us-east-1', root, fileBase: fixtures, env: { SAMPLE_GREETING: 'howdy' } });

  it('resolves opt, env (with default), aws, and self paths', () => {
    const c = ctx();
    expect(interpolateString('${opt:stage, \'dev\'}', c)).toBe('local');
    expect(interpolateString('${env:SAMPLE_GREETING, \'hello\'}', c)).toBe('howdy');
    expect(interpolateString('${env:MISSING, \'fallback\'}', c)).toBe('fallback');
    expect(interpolateString('${aws:accountId}', c)).toBe('000000000000');
    expect(interpolateString('${aws:region}', c)).toBe('us-east-1');
    expect(interpolateString('svc-${self:custom.stage}', c)).toBe('svc-local');
  });

  it('resolves nested ${custom.${custom.stage}.cpu} paths', () => {
    const c = ctx();
    expect(Number(interpolateString('${self:custom.${self:custom.stage}.cpu}', c))).toBe(128);
  });

  it('stubs SSM Secrets Manager lookups as a SecretBag and records keys', () => {
    const doc: Record<string, unknown> = {
      custom: {
        stage: '${opt:stage, \'dev\'}',
        appSecrets: '${ssm:/aws/reference/secretsmanager/${self:custom.stage}/app-secrets}',
      },
      provider: { environment: { TOKEN: '${self:custom.appSecrets.API_TOKEN}' } },
    };
    const c = createCtx({ stage: 'local', region: 'us-east-1', root: doc, fileBase: fixtures });
    interpolateTree(doc, c);
    expect((doc.custom as { appSecrets: SecretBag }).appSecrets).toBeInstanceOf(SecretBag);
    expect((doc.provider as { environment: { TOKEN: string } }).environment.TOKEN).toBe('PLACEHOLDER');
    const secrets = collectSecrets(c);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].name).toBe('aws-emulator/local/app-secrets');
    expect(secrets[0].keys).toContain('API_TOKEN');
  });
});

describe('detect + plan fixtures', () => {
  it('detects serverless-mini.yml and trinity-mini.yml', () => {
    const found = detectConfigs(fixtures);
    expect(found.map((f) => f.kind).sort()).toEqual(['serverless', 'trinity']);
  });

  it('plans the sample serverless service', () => {
    const parsed = parseServerlessFile(path.join(fixtures, 'sample-api', 'serverless.yml'), { stage: 'local', region: 'us-east-1' });
    const plan = planServerless(parsed);
    expect(plan.service).toBe('sample-api');
    const kinds = plan.resources.map((r) => `${r.kind}:${r.name}`);
    expect(kinds.some((k) => k.startsWith('lambda:sample-api-local-ping'))).toBe(true);
    expect(kinds.some((k) => k.includes('sample-jobs-local'))).toBe(true);
    expect(kinds.some((k) => k.includes('sample-data-local'))).toBe(true);
    expect(kinds.some((k) => k.startsWith('apigateway:'))).toBe(true);
    expect(kinds.some((k) => k.includes('schedule'))).toBe(true);
    expect(plan.placeholders.some((p) => p.keys.includes('API_TOKEN'))).toBe(true);
  });

  it('plans the sample trinity service and falls back custom.local → custom.dev', () => {
    const parsed = parseTrinityFile(path.join(fixtures, 'sample-web', 'trinity.yml'), { stage: 'local', region: 'us-east-1' });
    const plan = planTrinity(parsed);
    expect(plan.service).toBe('sample-web');
    expect(plan.resources.some((r) => r.kind === 'ecs-cluster')).toBe(true);
    expect(plan.resources.some((r) => r.kind === 'ecr')).toBe(true);
    expect(plan.resources.some((r) => r.kind === 'ecs-service')).toBe(true);
    expect(plan.resources.some((r) => r.kind === 'alb')).toBe(true);
    expect(plan.placeholders.some((p) => p.keys.includes('DATABASE_URL'))).toBe(true);
  });
});
