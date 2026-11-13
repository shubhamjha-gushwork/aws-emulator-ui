import { describe, expect, it } from 'vitest';
import path from 'path';
import { triggerState, triggerEnabled, serviceDesiredCount, noRunDetail } from '../src/lib/deploy/run-mode';
import { parseServerlessFile, planServerless } from '../src/lib/deploy/serverless/parse';
import { parseTrinityFile, planTrinity } from '../src/lib/deploy/trinity/parse';

const fixtures = path.join(__dirname, 'fixtures');

describe('run-mode', () => {
  it('disables triggers and forces ECS desiredCount 0 when noRun is set', () => {
    expect(triggerState(true)).toBe('DISABLED');
    expect(triggerState(false)).toBe('ENABLED');
    expect(triggerEnabled(true)).toBe(false);
    expect(triggerEnabled(false)).toBe(true);
    expect(serviceDesiredCount(true, 3, 2)).toBe(0);
    expect(serviceDesiredCount(false, 3, 2)).toBe(3);
    expect(serviceDesiredCount(false, undefined, 2)).toBe(2);
    expect(serviceDesiredCount(false)).toBe(1);
    expect(noRunDetail(true, 'rate(5 minutes)')).toBe('rate(5 minutes) · DISABLED (--no-run)');
    expect(noRunDetail(false, 'rate(5 minutes)')).toBe('rate(5 minutes)');
  });
});

describe('plans honor --no-run', () => {
  it('marks serverless schedules and SQS mappings as disabled', () => {
    const parsed = parseServerlessFile(path.join(fixtures, 'sample-api', 'serverless.yml'), { stage: 'local', region: 'us-east-1' });
    const on = planServerless(parsed);
    const off = planServerless(parsed, { noRun: true });
    const sched = off.resources.find((r) => r.kind === 'event-rule');
    const map = off.resources.find((r) => r.kind === 'event-source-mapping');
    expect(sched?.detail).toContain('DISABLED (--no-run)');
    expect(map?.detail).toContain('DISABLED (--no-run)');
    expect(on.resources.find((r) => r.kind === 'event-rule')?.detail).not.toContain('--no-run');
  });

  it('sets trinity services to desiredCount 0', () => {
    const parsed = parseTrinityFile(path.join(fixtures, 'sample-web', 'trinity.yml'), { stage: 'local', region: 'us-east-1' });
    const off = planTrinity(parsed, { noRun: true });
    const svc = off.resources.find((r) => r.kind === 'ecs-service');
    expect(svc?.detail).toBe('desiredCount 0');
    const on = planTrinity(parsed);
    expect(on.resources.find((r) => r.kind === 'ecs-service')?.detail).toBe('desiredCount 1');
  });
});
