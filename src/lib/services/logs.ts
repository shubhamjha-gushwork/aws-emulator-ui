import {
  CloudWatchLogsClient, DescribeLogGroupsCommand, CreateLogGroupCommand, DeleteLogGroupCommand, DescribeLogStreamsCommand,
  GetLogEventsCommand, FilterLogEventsCommand, CreateLogStreamCommand, PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { type ServiceModule, str, optStr, num, safeCount } from './types';

export const logs: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(CloudWatchLogsClient);
    return [{ label: 'Log groups', value: await safeCount(async () => (await c.send(new DescribeLogGroupsCommand({}))).logGroups?.length ?? 0) }];
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
      return out;
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
