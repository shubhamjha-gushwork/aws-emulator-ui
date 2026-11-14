import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCtx, interpolateString, interpolateTree, collectSecrets, SecretBag, PLACEHOLDER } from '../src/lib/deploy/interpolate';
import { detectConfigs } from '../src/lib/deploy/detect';
import { parseServerlessFile, planServerless } from '../src/lib/deploy/serverless/parse';
import { parseTrinityFile, planTrinity } from '../src/lib/deploy/trinity/parse';
import { annotatePlan } from '../src/lib/deploy';

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
    const rel = found.map((f) => `${f.kind}:${path.relative(fixtures, f.file)}`);
    expect(rel).toContain(`serverless:${path.join('sample-api', 'serverless.yml')}`);
    expect(rel).toContain(`trinity:${path.join('sample-web', 'trinity.yml')}`);
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

describe('YAML defaults vs missing secret keys', () => {
  it('uses the YAML default when a secret key is not in the env file, and PLACEHOLDER only with no default', () => {
    const doc: Record<string, unknown> = {
      custom: {
        stage: "local",
        appSecrets: '${ssm:/aws/reference/secretsmanager/${self:custom.stage}/app-secrets}',
      },
      provider: {
        environment: {
          POSTHOG_HOST: "${self:custom.appSecrets.POSTHOG_HOST, 'https://us.posthog.com'}",
          APEX_PROXY_IPS: "${self:custom.appSecrets.APEX_PROXY_IPS, '1.2.3.4'}",
          API_TOKEN: '${self:custom.appSecrets.API_TOKEN}',
          EMPTY_DEFAULT: "${self:custom.appSecrets.EMPTY_DEFAULT, ''}",
        },
      },
    };
    const c = createCtx({ stage: 'local', region: 'us-east-1', root: doc, fileBase: fixtures, fileEnv: {} });
    interpolateTree(doc, c);
    const env = (doc.provider as { environment: Record<string, string> }).environment;
    expect(env.POSTHOG_HOST).toBe('https://us.posthog.com');
    expect(env.APEX_PROXY_IPS).toBe('1.2.3.4');
    expect(env.API_TOKEN).toBe(PLACEHOLDER);
    expect(env.EMPTY_DEFAULT).toBe('');
    expect(env.POSTHOG_HOST).not.toBe(PLACEHOLDER);
    expect(c.defaultedKeys.has('POSTHOG_HOST')).toBe(true);
    expect(c.defaultedKeys.has('APEX_PROXY_IPS')).toBe(true);
    expect(c.defaultedKeys.has('EMPTY_DEFAULT')).toBe(true);
    expect(c.defaultedKeys.has('API_TOKEN')).toBe(false);
    const secrets = collectSecrets(c);
    expect(secrets[0].keys).toEqual(['APEX_PROXY_IPS', 'API_TOKEN', 'EMPTY_DEFAULT', 'POSTHOG_HOST']);
    expect(secrets[0].defaulted).toEqual(['APEX_PROXY_IPS', 'EMPTY_DEFAULT', 'POSTHOG_HOST']);
    expect(JSON.stringify(secrets)).not.toContain('https://us.posthog.com');
  });

  it('lets a present env-file value win over the YAML default', () => {
    const doc: Record<string, unknown> = {
      custom: {
        stage: 'local',
        appSecrets: '${ssm:/aws/reference/secretsmanager/local/app-secrets}',
      },
      provider: {
        environment: {
          POSTHOG_HOST: "${self:custom.appSecrets.POSTHOG_HOST, 'https://us.posthog.com'}",
          API_TOKEN: '${self:custom.appSecrets.API_TOKEN}',
        },
      },
    };
    const hidden = 'env-file-host-do-not-leak';
    const c = createCtx({
      stage: 'local',
      region: 'us-east-1',
      root: doc,
      fileBase: fixtures,
      fileEnv: { POSTHOG_HOST: hidden },
    });
    interpolateTree(doc, c);
    const env = (doc.provider as { environment: Record<string, string> }).environment;
    expect(env.POSTHOG_HOST).toBe(hidden);
    expect(env.POSTHOG_HOST).not.toBe('https://us.posthog.com');
    expect(env.API_TOKEN).toBe(PLACEHOLDER);
    expect(c.defaultedKeys.has('POSTHOG_HOST')).toBe(false);
    const secrets = collectSecrets(c);
    expect(secrets[0].defaulted).toEqual([]);
    expect(JSON.stringify(secrets)).not.toContain(hidden);
    expect(JSON.stringify({ name: c.secrets.get('aws-emulator/local/app-secrets')?.toJSON() })).not.toContain(hidden);
  });

  it('does not treat a bare ${ssm:...} SecretBag as missing when a default is present (keeps the bag)', () => {
    const doc: Record<string, unknown> = {
      custom: {
        appSecrets: "${ssm:/aws/reference/secretsmanager/local/app-secrets, 'fallback'}",
      },
    };
    const c = createCtx({ stage: 'local', region: 'us-east-1', root: doc, fileBase: fixtures, fileEnv: {} });
    interpolateTree(doc, c);
    expect((doc.custom as { appSecrets: SecretBag }).appSecrets).toBeInstanceOf(SecretBag);
  });

  it('annotates plan keys as filled, defaulted, or missing without leaking values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-def-'));
    fs.writeFileSync(
      path.join(dir, 'serverless.yml'),
      `
service: defaults-demo
custom:
  stage: \${opt:stage, 'dev'}
  appSecrets: \${ssm:/aws/reference/secretsmanager/\${self:custom.stage}/app-secrets}
provider:
  environment:
    POSTHOG_HOST: \${self:custom.appSecrets.POSTHOG_HOST, 'https://us.posthog.com'}
    API_TOKEN: \${self:custom.appSecrets.API_TOKEN}
    FROM_FILE: \${self:custom.appSecrets.FROM_FILE, 'should-not-win'}
functions:
  ping:
    handler: index.handler
`,
    );
    const hidden = 'file-value-do-not-leak';
    const parsed = parseServerlessFile(path.join(dir, 'serverless.yml'), {
      stage: 'local',
      region: 'us-east-1',
      fileEnv: { FROM_FILE: hidden },
    });
    const plan = annotatePlan(planServerless(parsed), { FROM_FILE: hidden });
    const ph = plan.placeholders[0];
    expect(ph.filled).toEqual(['FROM_FILE']);
    expect(ph.defaulted).toEqual(['POSTHOG_HOST']);
    expect(ph.missing).toEqual(['API_TOKEN']);
    const dumped = JSON.stringify(plan.placeholders);
    expect(dumped).not.toContain(hidden);
    expect(dumped).not.toContain('should-not-win');
    expect(dumped).not.toContain('https://us.posthog.com');
    expect(parsed.environment.POSTHOG_HOST).toBe('https://us.posthog.com');
    expect(parsed.environment.FROM_FILE).toBe(hidden);
    expect(parsed.environment.API_TOKEN).toBe(PLACEHOLDER);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('file() includes', () => {
  it('resolves ${self:} in an included file against the service document, not the include', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-file-'));
    fs.writeFileSync(path.join(dir, 'sm.yml'), 'name: orders-create-project-${self:custom.stage}\ndefinition:\n  StartAt: A\n  States: {}\n');
    const doc: Record<string, unknown> = {
      custom: { stage: '${opt:stage, \'dev\'}' },
      stepFunctions: { stateMachines: { CreateProject: '${file(sm.yml)}' } },
    };
    const c = createCtx({ stage: 'local', region: 'us-east-1', root: doc, fileBase: dir });
    interpolateTree(doc, c);
    const sm = (doc.stepFunctions as { stateMachines: { CreateProject: { name: string } } }).stateMachines.CreateProject;
    expect(sm.name).toBe('orders-create-project-local');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
