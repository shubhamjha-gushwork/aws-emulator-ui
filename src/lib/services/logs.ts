import {
  CloudWatchLogsClient, DescribeLogGroupsCommand, CreateLogGroupCommand, DeleteLogGroupCommand, DescribeLogStreamsCommand,
  GetLogEventsCommand, FilterLogEventsCommand, CreateLogStreamCommand, PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient, ListTaskDefinitionFamiliesCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { type ServiceModule, str, optStr, num, safeCount, inRegion } from './types';

export const logs: ServiceModule = {
  async counts(ctx) {
    return [{ label: 'Log groups', value: await safeCount(async () => ((await logs.actions.groups(ctx, {})) as unknown[]).length) }];
  },
  actions: {
    async groups(ctx, p) {
      const c = ctx.client(CloudWatchLogsClient);
      const out = [];
      let nextToken: string | undefined;
      do {
        const r = await c.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: optStr(p, 'prefix'), nextToken }));
        out.push(...(r.logGroups ?? []));
        nextToken = r.nextToken;
      } while (nextToken && out.length < 1000);
      return out.filter((g) => inRegion(ctx, g.arn));
    },
    /** Log groups referenced by ECS task definitions (awslogs-group), latest revision of each active family. */
    async ecsGroups(ctx) {
      const ecs = ctx.client(ECSClient);
      const families = ((await ecs.send(new ListTaskDefinitionFamiliesCommand({ status: 'ACTIVE' }))).families ?? []).slice(0, 100);
      const groups = new Set<string>();
      for (const family of families) {
        try {
          const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: family }))).taskDefinition;
          if (!inRegion(ctx, td?.taskDefinitionArn)) continue;
          for (const c of td?.containerDefinitions ?? []) {
            const g = c.logConfiguration?.logDriver === 'awslogs' ? c.logConfiguration.options?.['awslogs-group'] : undefined;
            if (g) groups.add(g);
          }
        } catch {
          // a family from another region or a deleted revision; skip it
        }
      }
      return [...groups];
    },
    async createGroup(ctx, p) {
      await ctx.client(CloudWatchLogsClient).send(new CreateLogGroupCommand({ logGroupName: str(p, 'name') }));
      return { created: true };
    },
    async deleteGroup(ctx, p) {
      await ctx.client(CloudWatchLogsClient).send(new DeleteLogGroupCommand({ logGroupName: str(p, 'name') }));
      return { deleted: true };
    },
    async streams(ctx, p) {
      const r = await ctx.client(CloudWatchLogsClient).send(
        new DescribeLogStreamsCommand({ logGroupName: str(p, 'group'), orderBy: 'LastEventTime', descending: true, limit: 50 }),
      );
      return r.logStreams ?? [];
    },
    /** Tail: newest events of one stream (forward token lets the UI poll for more). */
    async events(ctx, p) {
      const r = await ctx.client(CloudWatchLogsClient).send(
        new GetLogEventsCommand({
          logGroupName: str(p, 'group'),
          logStreamName: str(p, 'stream'),
          limit: num(p, 'limit', 200),
          startFromHead: optStr(p, 'nextToken') ? true : false,
          nextToken: optStr(p, 'nextToken'),
        }),
      );
      return { events: r.events ?? [], nextForwardToken: r.nextForwardToken };
    },
    async filter(ctx, p) {
      const r = await ctx.client(CloudWatchLogsClient).send(
        new FilterLogEventsCommand({ logGroupName: str(p, 'group'), filterPattern: optStr(p, 'pattern'), limit: num(p, 'limit', 200) }),
      );
      return r.events ?? [];
    },
    async putEvent(ctx, p) {
      const c = ctx.client(CloudWatchLogsClient);
      const logGroupName = str(p, 'group');
      const logStreamName = optStr(p, 'stream') ?? 'aws-emulator-ui';
      await c.send(new CreateLogStreamCommand({ logGroupName, logStreamName })).catch((e) => {
        if (e?.name !== 'ResourceAlreadyExistsException') throw e;
      });
      await c.send(new PutLogEventsCommand({ logGroupName, logStreamName, logEvents: [{ timestamp: Date.now(), message: str(p, 'message') }] }));
      return { stream: logStreamName };
    },
  },
};
