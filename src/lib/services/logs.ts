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
      const groups = out.filter((g) => inRegion(ctx, g.arn));
      if (!p.stats) return groups;
      // Streams count and last event per group (first 200 groups), for the log groups table.
      return Promise.all(
        groups.map(async (g, i) => {
          if (i >= 200) return g;
          try {
            const r = await c.send(new DescribeLogStreamsCommand({ logGroupName: g.logGroupName, orderBy: 'LastEventTime', descending: true, limit: 50 }));
            const st = r.logStreams ?? [];
            return { ...g, streamCount: st.length, moreStreams: !!r.nextToken, lastEventTimestamp: st.reduce((m, x) => Math.max(m, x.lastEventTimestamp ?? x.lastIngestionTime ?? 0), 0) || undefined };
          } catch {
            return g;
          }
        }),
      );
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
    /**
     * One query for the log group view: optional filter pattern, stream and start time, oldest → newest.
     * Reads up to 5,000 matches and returns the newest `limit` (default 500), so following works on big groups too.
     */
    async query(ctx, p) {
      const c = ctx.client(CloudWatchLogsClient);
      const limit = Math.min(num(p, 'limit', 500), 2000);
      const stream = optStr(p, 'stream');
      const startTime = p.startTime === undefined || p.startTime === null || p.startTime === '' ? undefined : num(p, 'startTime');
      const events: { eventId?: string; timestamp?: number; message?: string; logStreamName?: string; ingestionTime?: number }[] = [];
      let nextToken: string | undefined;
      let pages = 0;
      do {
        const r = await c.send(
          new FilterLogEventsCommand({
            logGroupName: str(p, 'group'),
            filterPattern: optStr(p, 'pattern')?.trim() || undefined,
            logStreamNames: stream ? [stream] : undefined,
            startTime,
            nextToken,
            limit: 1000,
          }),
        );
        events.push(...(r.events ?? []));
        nextToken = r.nextToken;
      } while (nextToken && ++pages < 5);
      events.sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
      return { events: events.slice(-limit), total: events.length, truncated: events.length > limit || !!nextToken };
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
