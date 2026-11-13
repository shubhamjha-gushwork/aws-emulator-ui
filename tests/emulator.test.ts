/**
 * Live checks against a running AWS Emulator. Skipped automatically when none is reachable.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { healthCheck, resolveConfig } from '@/lib/aws';
import { makeCtx } from '@/lib/services/types';
import { services } from '@/lib/services';
import { DEFAULT_SETTINGS } from '@/lib/settings';

let up = false;
beforeAll(async () => {
  up = (await healthCheck(await resolveConfig(DEFAULT_SETTINGS))).ok;
});

describe('AWS Emulator (live)', () => {
  it('every overview count call succeeds', async (t) => {
    if (!up) return t.skip();
    const ctx = makeCtx(await resolveConfig(DEFAULT_SETTINGS));
    for (const [id, mod] of Object.entries(services)) {
      const counts = await mod.counts(ctx);
      for (const c of counts) expect(c.value, `${id} ${c.label}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('S3 round trip', async (t) => {
    if (!up) return t.skip();
    const ctx = makeCtx(await resolveConfig(DEFAULT_SETTINGS));
    const bucket = `vitest-${Date.now().toString(36)}`;
    await services.s3.actions.createBucket(ctx, { bucket });
    await services.s3.actions.putObject(ctx, { bucket, key: 'a.txt', base64: Buffer.from('x').toString('base64') });
    const l = (await services.s3.actions.listObjects(ctx, { bucket })) as { objects: { Key: string }[] };
    expect(l.objects.map((o) => o.Key)).toContain('a.txt');
    await services.s3.actions.emptyBucket(ctx, { bucket });
    await services.s3.actions.deleteBucket(ctx, { bucket });
  });

  it('ECS DescribeServices parses despite nanosecond timestamps', { timeout: 20000 }, async (t) => {
    if (!up) return t.skip();
    const ctx = makeCtx(await resolveConfig(DEFAULT_SETTINGS));
    const name = `vitest-${Date.now().toString(36)}`;
    await services.ecs.actions.createCluster(ctx, { name });
    const td = (await services.ecs.actions.registerTaskDefinition(ctx, { family: name, image: 'nginx' })) as { taskDefinitionArn: string };
    const net = (await services.elb.actions.network(ctx, {})) as { subnets: { id: string }[] };
    await services.ecs.actions.createService(ctx, { cluster: name, name: 'svc', taskDefinition: td.taskDefinitionArn, desiredCount: 0, subnet: net.subnets[0].id });
    const svcs = (await services.ecs.actions.services(ctx, { cluster: name })) as { serviceName: string; createdAt: Date }[];
    expect(svcs[0].serviceName).toBe('svc');
    expect(svcs[0].createdAt).toBeInstanceOf(Date);
    await services.ecs.actions.deleteService(ctx, { cluster: name, service: 'svc' });
    for (let i = 0; i < 20; i++) {
      // the cluster can only go once the service has finished draining
      const ok = await services.ecs.actions.deleteCluster(ctx, { cluster: name }).then(() => true, () => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });
});
