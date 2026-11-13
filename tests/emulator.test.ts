import { IAMClient, CreateRoleCommand, DeleteRoleCommand } from '@aws-sdk/client-iam';
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
    await services.ecs.actions.deregisterTaskDefinition(ctx, { taskDefinition: td.taskDefinitionArn });
    await services.logs.actions.deleteGroup(ctx, { name: `/ecs/${name}` }).catch(() => undefined);
  });

  it('ECS works in ap-south-1 and lists stay region-scoped (regression: "Invalid Region in ARN")', { timeout: 60000 }, async (t) => {
    if (!up) return t.skip();
    const id = Date.now().toString(36);
    const east = makeCtx(await resolveConfig({ ...DEFAULT_SETTINGS, region: 'us-east-1' }));
    const south = makeCtx(await resolveConfig({ ...DEFAULT_SETTINGS, region: 'ap-south-1' }));
    const e = services.ecs.actions;
    await e.createCluster(east, { name: `vitest-e-${id}` });
    await e.createCluster(south, { name: `vitest-s-${id}` });
    const net = (await services.elb.actions.network(south, {})) as { subnets: { id: string }[] };
    const td = (await e.registerTaskDefinition(south, { family: `vitest-${id}`, image: 'busybox', command: `echo vitest-hello-${id}` })) as { taskDefinitionArn: string; containerDefinitions: { logConfiguration?: { options?: Record<string, string> } }[] };
    expect(td.taskDefinitionArn).toContain(':ap-south-1:');
    expect(td.containerDefinitions[0].logConfiguration?.options?.['awslogs-group']).toBe(`/ecs/vitest-${id}`);
    const run = (await e.runTask(south, { cluster: `vitest-s-${id}`, taskDefinition: td.taskDefinitionArn, subnet: net.subnets[0].id })) as { tasks: { taskArn: string }[] };
    expect(run.tasks[0].taskArn).toContain(':ap-south-1:');
    // awslogs: the emulator runs the shell command and writes its output to /ecs/<family>
    let lines: string[] = [];
    for (let i = 0; i < 40 && !lines.some((l) => l.includes(`vitest-hello-${id}`)); i++) {
      await new Promise((r) => setTimeout(r, 500));
      const streams = (await services.logs.actions.streams(south, { group: `/ecs/vitest-${id}` })) as { logStreamName: string }[];
      lines = [];
      for (const st of streams) lines.push(...((await services.logs.actions.events(south, { group: `/ecs/vitest-${id}`, stream: st.logStreamName })) as { events: { message: string }[] }).events.map((x) => x.message));
    }
    expect(lines).toContain(`vitest-hello-${id}`);
    const svc = (await e.createService(south, { cluster: `vitest-s-${id}`, name: 'svc', taskDefinition: td.taskDefinitionArn, desiredCount: 0, subnet: net.subnets[0].id })) as { serviceArn: string };
    expect(svc.serviceArn).toContain(':ap-south-1:');
    for (const [ctx, region] of [[south, 'ap-south-1'], [east, 'us-east-1']] as const) {
      const clusters = (await e.clusters(ctx, {})) as { clusterArn: string }[];
      expect(clusters.length).toBeGreaterThan(0);
      for (const c of clusters) expect(c.clusterArn).toContain(`:${region}:`);
      for (const a of (await e.taskDefinitions(ctx, {})) as string[]) expect(a).toContain(`:${region}:`);
    }
    await expect(e.createCluster(east, { name: `vitest-s-${id}` })).rejects.toThrow(/already exists in ap-south-1/);
    await e.deleteService(south, { cluster: `vitest-s-${id}`, service: 'svc' });
    for (const [ctx, c] of [[south, `vitest-s-${id}`], [east, `vitest-e-${id}`]] as const) {
      for (const tk of (await e.tasks(ctx, { cluster: c })) as { taskArn: string }[]) await e.stopTask(ctx, { cluster: c, task: tk.taskArn }).catch(() => undefined);
      for (let i = 0; i < 40; i++) {
        if (await e.deleteCluster(ctx, { cluster: c }).then(() => true, () => false)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await e.deregisterTaskDefinition(south, { taskDefinition: td.taskDefinitionArn });
    await services.logs.actions.deleteGroup(south, { name: `/ecs/vitest-${id}` }).catch(() => undefined);
  });

  it('Lambda logs reach /aws/lambda/<fn>: written by the emulator (helper role) or captured by the UI (bare role)', { timeout: 30000 }, async (t) => {
    if (!up) return t.skip();
    const ctx = makeCtx(await resolveConfig({ ...DEFAULT_SETTINGS, region: 'eu-west-1' }));
    const id = Date.now().toString(36);
    const iam = ctx.client(IAMClient);
    const bare = (await iam.send(new CreateRoleCommand({ RoleName: `vitest-bare-${id}`, AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }))).Role!.Arn!;
    for (const [fn, role, byUi] of [[`vitest-h-${id}`, undefined, false], [`vitest-b-${id}`, bare, true]] as const) {
      await services.lambda.actions.create(ctx, { name: fn, runtime: 'python3.12', role });
      const r = (await services.lambda.actions.invoke(ctx, { name: fn, payload: '{"a":1}' })) as { captured?: { group: string; stream?: string; skipped?: string } };
      expect(r.captured?.group).toBe(`/aws/lambda/${fn}`);
      if (byUi) expect(r.captured?.stream).toContain('captured-by-ui');
      else expect(r.captured?.skipped).toBeTruthy();
      const logs = (await services.lambda.actions.logs(ctx, { name: fn })) as { events: { message: string; capturedByUi: boolean }[] };
      expect(logs.events.some((e) => e.message.startsWith('START') && e.capturedByUi === byUi)).toBe(true);
      await services.lambda.actions.delete(ctx, { name: fn });
      await services.logs.actions.deleteGroup(ctx, { name: `/aws/lambda/${fn}` });
    }
    await iam.send(new DeleteRoleCommand({ RoleName: `vitest-bare-${id}` }));
  });

  it('API Gateway MOCK method answers 200 through the data plane', { timeout: 20000 }, async (t) => {
    if (!up) return t.skip();
    const ctx = makeCtx(await resolveConfig({ ...DEFAULT_SETTINGS, region: 'ap-south-1' }));
    const a = services.apigateway.actions;
    const api = (await a.createRestApi(ctx, { name: `vitest-${Date.now().toString(36)}` })) as { id: string };
    await a.addMockMethod(ctx, { id: api.id, pathPart: 'ping', method: 'GET' });
    await a.createDeployment(ctx, { id: api.id, stage: 'dev' });
    const r = (await a.invoke(ctx, { id: api.id, stage: 'dev', path: '/ping' })) as { status: number; body: string };
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, mock: true });
    await a.deleteRestApi(ctx, { id: api.id });
  });
});
