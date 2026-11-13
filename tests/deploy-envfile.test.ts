import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEnvContent, parseEnvFile, findDefaultEnvFile, buildSecretPayload, fillPlaceholderEnv, classifyKeys, renderEnvExample, mask } from '../src/lib/deploy/envfile';
import { collectSecrets, createCtx, interpolateTree, promoteSecretsManagerRefs, SecretBag, PLACEHOLDER } from '../src/lib/deploy/interpolate';
import { parseTrinityFile, planTrinity } from '../src/lib/deploy/trinity/parse';
import { annotatePlan } from '../src/lib/deploy';
import { PLACEHOLDER_VALUE } from '../src/lib/deploy/types';

describe('parseEnvContent', () => {
  it('parses quotes, export, comments, and skips invalid keys', () => {
    const env = parseEnvContent(`
# comment
export FOO=bar
BAZ="quoted value"
QUOTED='single'
SPACED= after
WITH_HASH=keep # not a comment-in-quotes
# SKIP
123BAD=no
OK_1=yes
EMPTY=
`);
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('quoted value');
    expect(env.QUOTED).toBe('single');
    expect(env.SPACED).toBe('after');
    expect(env.WITH_HASH).toBe('keep');
    expect(env.OK_1).toBe('yes');
    expect(env.EMPTY).toBe('');
    expect(env['123BAD']).toBeUndefined();
  });

  it('never includes values in mask() or example templates', () => {
    const secret = 'super-secret-value-do-not-leak';
    expect(mask(secret)).toBe('***');
    expect(mask(secret)).not.toContain('super');
    const example = renderEnvExample(['API_TOKEN', 'DATABASE_URL']);
    expect(example).toContain('API_TOKEN=');
    expect(example).toContain('DATABASE_URL=');
    expect(example).not.toContain(secret);
  });
});

describe('findDefaultEnvFile', () => {
  it('prefers .env.local over .env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-env-'));
    fs.writeFileSync(path.join(dir, '.env'), 'FROM=env\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'FROM=local\n');
    const found = findDefaultEnvFile(dir)!;
    expect(path.basename(found)).toBe('.env.local');
    expect(parseEnvFile(found).FROM).toBe('local');
    fs.writeFileSync(path.join(dir, 'service.yml'), '');
    expect(path.basename(findDefaultEnvFile(path.join(dir, 'service.yml'))!)).toBe('.env.local');
  });
});

describe('fill secrets from env keys', () => {
  it('builds JSON from matching keys and reports missing names only', () => {
    const { secretString, filled, missing } = buildSecretPayload(['API_TOKEN', 'DATABASE_URL'], { API_TOKEN: 'hidden-token' });
    expect(filled).toEqual(['API_TOKEN']);
    expect(missing).toEqual(['DATABASE_URL']);
    const parsed = JSON.parse(secretString) as Record<string, string>;
    expect(parsed.API_TOKEN).toBe('hidden-token');
    expect(parsed.DATABASE_URL).toBe(PLACEHOLDER_VALUE);
    // classify / reports must be names only
    expect(JSON.stringify(classifyKeys(['API_TOKEN', 'DATABASE_URL'], { API_TOKEN: 'hidden-token' }))).not.toContain('hidden-token');
  });

  it('replaces PLACEHOLDER env vars in place when keys match', () => {
    const vars = { STAGE: 'local', API_TOKEN: PLACEHOLDER, OTHER: PLACEHOLDER_VALUE };
    const filled = fillPlaceholderEnv(vars, { API_TOKEN: 'hidden-token' });
    expect(filled).toEqual(['API_TOKEN']);
    expect(vars.API_TOKEN).toBe('hidden-token');
    expect(vars.OTHER).toBe(PLACEHOLDER_VALUE);
    expect(vars.STAGE).toBe('local');
  });
});

describe('Trinity Secrets Manager ARNs', () => {
  it('promotes environment.refs ARNs to SecretBags and records keys', () => {
    const doc: Record<string, unknown> = {
      custom: { stage: 'local' },
      environment: {
        refs: {
          appSecrets: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:${custom.stage}/app-secrets-*',
        },
        variables: {
          DATABASE_URL: '${environment.refs.appSecrets.DATABASE_URL}',
        },
      },
    };
    const ctx = createCtx({ stage: 'local', region: 'us-east-1', root: doc, fileBase: os.tmpdir() });
    interpolateTree(doc.custom, ctx);
    interpolateTree((doc.environment as { refs: unknown }).refs, ctx);
    promoteSecretsManagerRefs((doc.environment as { refs: unknown }).refs, ctx);
    interpolateTree(doc, ctx);
    const refs = (doc.environment as { refs: { appSecrets: SecretBag } }).refs;
    expect(refs.appSecrets).toBeInstanceOf(SecretBag);
    expect((doc.environment as { variables: { DATABASE_URL: string } }).variables.DATABASE_URL).toBe(PLACEHOLDER);
    const secrets = collectSecrets(ctx);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].name).toBe('aws-emulator/local/app-secrets');
    expect(secrets[0].keys).toContain('DATABASE_URL');
    expect(JSON.stringify(secrets)).not.toMatch(/\d{12}/);
  });

  it('plans a trinity file with ARN refs and annotates missing/filled keys without leaking values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-tr-'));
    fs.writeFileSync(path.join(dir, 'trinity.yml'), `
name: sample-arn
region: us-east-1
environment:
  refs:
    appSecrets: arn:aws:secretsmanager:us-east-1:000000000000:secret:\${custom.stage}/app-secrets-*
  variables:
    DATABASE_URL: \${environment.refs.appSecrets.DATABASE_URL}
    API_TOKEN: \${environment.refs.appSecrets.API_TOKEN}
custom:
  dev:
    cpu: 256
stacks:
  Fargate:
    - clusterName: sample
      tasks:
        - name: web
          dockerfile: Dockerfile
`);
    const parsed = parseTrinityFile(path.join(dir, 'trinity.yml'), { stage: 'local', region: 'us-east-1' });
    const plan = annotatePlan(planTrinity(parsed), { DATABASE_URL: 'hidden-db-url' });
    const ph = plan.placeholders.find((p) => p.name === 'aws-emulator/local/app-secrets');
    expect(ph).toBeTruthy();
    expect(ph!.filled).toEqual(['DATABASE_URL']);
    expect(ph!.missing).toEqual(['API_TOKEN']);
    const dumped = JSON.stringify(plan.placeholders);
    expect(dumped).not.toContain('hidden-db-url');
    expect(dumped).toContain('API_TOKEN');
  });
});

import { fitFargateResources } from '../src/lib/deploy/trinity/fargate';

describe('fitFargateResources', () => {
  it('keeps a valid pair and snaps 512/1800 up to 512/2048', () => {
    expect(fitFargateResources(512, 1024)).toEqual({ cpu: 512, memory: 1024, adjusted: false });
    expect(fitFargateResources(512, 1800)).toEqual({ cpu: 512, memory: 2048, adjusted: true });
    expect(fitFargateResources(256, 300)).toEqual({ cpu: 256, memory: 512, adjusted: true });
  });
});
