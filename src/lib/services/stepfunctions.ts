import {
  SFNClient, ListStateMachinesCommand, DescribeStateMachineCommand, CreateStateMachineCommand, DeleteStateMachineCommand,
  ListExecutionsCommand, StartExecutionCommand, DescribeExecutionCommand, GetExecutionHistoryCommand, StopExecutionCommand,
  UpdateStateMachineCommand, StartSyncExecutionCommand,
} from '@aws-sdk/client-sfn';
import { type Ctx, type ServiceModule, str, optStr, json, safeCount, inRegion } from './types';
import { roleOrHelper } from './iam-role';

// StartSyncExecution normally goes to a "sync-" host prefix; the emulator serves everything on one host.
const sfn = (ctx: Ctx) => ctx.client(SFNClient, { disableHostPrefix: true });

export const stepfunctions: ServiceModule = {
  async counts(ctx) {
    return [{ label: 'State machines', value: await safeCount(async () => ((await stepfunctions.actions.list(ctx, {})) as unknown[]).length) }];
  },
  actions: {
    async list(ctx) {
      const c = sfn(ctx);
      const out = [];
      let nextToken: string | undefined;
      do {
        const r = await c.send(new ListStateMachinesCommand({ nextToken }));
        out.push(...(r.stateMachines ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
      return out.filter((m) => inRegion(ctx, m.stateMachineArn));
    },
    async describe(ctx, p) {
      return sfn(ctx).send(new DescribeStateMachineCommand({ stateMachineArn: str(p, 'arn') }));
    },
    async create(ctx, p) {
      const definition = str(p, 'definition');
      json(definition, 'Definition');
      return sfn(ctx).send(
        new CreateStateMachineCommand({ name: str(p, 'name'), definition, roleArn: await roleOrHelper(ctx, optStr(p, 'roleArn')), type: (optStr(p, 'type') as 'STANDARD' | 'EXPRESS') ?? 'STANDARD' }),
      );
    },
    async update(ctx, p) {
      const definition = optStr(p, 'definition');
      if (definition) json(definition, 'Definition');
      return sfn(ctx).send(new UpdateStateMachineCommand({ stateMachineArn: str(p, 'arn'), definition, roleArn: optStr(p, 'roleArn') }));
    },
    async delete(ctx, p) {
      await sfn(ctx).send(new DeleteStateMachineCommand({ stateMachineArn: str(p, 'arn') }));
      return { deleted: true };
    },
    async executions(ctx, p) {
      return (await sfn(ctx).send(new ListExecutionsCommand({ stateMachineArn: str(p, 'arn'), maxResults: 100 }))).executions ?? [];
    },
    async start(ctx, p) {
      const input = optStr(p, 'input') ?? '{}';
      json(input, 'Input');
      return sfn(ctx).send(new StartExecutionCommand({ stateMachineArn: str(p, 'arn'), input, name: optStr(p, 'name') }));
    },
    /** Synchronous run for EXPRESS state machines (their executions aren't listed or described, as on AWS). */
    async startSync(ctx, p) {
      const input = optStr(p, 'input') ?? '{}';
      json(input, 'Input');
      return sfn(ctx).send(new StartSyncExecutionCommand({ stateMachineArn: str(p, 'arn'), input, name: optStr(p, 'name') }));
    },
    async describeExecution(ctx, p) {
      return sfn(ctx).send(new DescribeExecutionCommand({ executionArn: str(p, 'executionArn') }));
    },
    async history(ctx, p) {
      return (await sfn(ctx).send(new GetExecutionHistoryCommand({ executionArn: str(p, 'executionArn'), maxResults: 500 }))).events ?? [];
    },
    async stop(ctx, p) {
      return sfn(ctx).send(new StopExecutionCommand({ executionArn: str(p, 'executionArn'), cause: 'Stopped from AWS Emulator' }));
    },
  },
};
