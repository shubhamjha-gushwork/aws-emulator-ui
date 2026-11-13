import {
  SFNClient, ListStateMachinesCommand, DescribeStateMachineCommand, CreateStateMachineCommand, DeleteStateMachineCommand,
  ListExecutionsCommand, StartExecutionCommand, DescribeExecutionCommand, GetExecutionHistoryCommand, StopExecutionCommand,
} from '@aws-sdk/client-sfn';
import { type ServiceModule, str, optStr, json, safeCount, DEFAULT_ROLE_ARN } from './types';

export const stepfunctions: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(SFNClient);
    return [{ label: 'State machines', value: await safeCount(async () => (await c.send(new ListStateMachinesCommand({}))).stateMachines?.length ?? 0) }];
  },
  actions: {
    async list(ctx) {
      const c = ctx.client(SFNClient);
      const out = [];
      let nextToken: string | undefined;
      do {
        const r = await c.send(new ListStateMachinesCommand({ nextToken }));
        out.push(...(r.stateMachines ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
      return out;
    },
    async describe(ctx, p) {
      return ctx.client(SFNClient).send(new DescribeStateMachineCommand({ stateMachineArn: str(p, 'arn') }));
    },
    async create(ctx, p) {
      const definition = str(p, 'definition');
      json(definition, 'Definition');
      return ctx.client(SFNClient).send(
        new CreateStateMachineCommand({ name: str(p, 'name'), definition, roleArn: optStr(p, 'roleArn') ?? DEFAULT_ROLE_ARN, type: (optStr(p, 'type') as 'STANDARD' | 'EXPRESS') ?? 'STANDARD' }),
      );
    },
    async delete(ctx, p) {
      await ctx.client(SFNClient).send(new DeleteStateMachineCommand({ stateMachineArn: str(p, 'arn') }));
      return { deleted: true };
    },
    async executions(ctx, p) {
      return (await ctx.client(SFNClient).send(new ListExecutionsCommand({ stateMachineArn: str(p, 'arn'), maxResults: 100 }))).executions ?? [];
    },
    async start(ctx, p) {
      const input = optStr(p, 'input') ?? '{}';
      json(input, 'Input');
      return ctx.client(SFNClient).send(new StartExecutionCommand({ stateMachineArn: str(p, 'arn'), input, name: optStr(p, 'name') }));
    },
    async describeExecution(ctx, p) {
      return ctx.client(SFNClient).send(new DescribeExecutionCommand({ executionArn: str(p, 'executionArn') }));
    },
    async history(ctx, p) {
      return (await ctx.client(SFNClient).send(new GetExecutionHistoryCommand({ executionArn: str(p, 'executionArn'), maxResults: 500 }))).events ?? [];
    },
    async stop(ctx, p) {
      return ctx.client(SFNClient).send(new StopExecutionCommand({ executionArn: str(p, 'executionArn'), cause: 'Stopped from AWS Emulator UI' }));
    },
  },
};
