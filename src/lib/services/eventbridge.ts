import {
  EventBridgeClient, ListEventBusesCommand, CreateEventBusCommand, DeleteEventBusCommand, ListRulesCommand,
  DescribeRuleCommand, PutRuleCommand, DeleteRuleCommand, EnableRuleCommand, DisableRuleCommand, ListTargetsByRuleCommand,
  PutTargetsCommand, RemoveTargetsCommand, PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  SchedulerClient, ListSchedulesCommand, GetScheduleCommand, CreateScheduleCommand, DeleteScheduleCommand,
  ListScheduleGroupsCommand,
} from '@aws-sdk/client-scheduler';
import { type ServiceModule, str, optStr, json, safeCount, InputError, inRegion } from './types';
import { roleOrHelper } from './iam-role';
import { grantServiceOnQueue } from './sns';

export const eventbridge: ServiceModule = {
  async counts(ctx) {
    const eb = ctx.client(EventBridgeClient);
    return [
      { label: 'Rules', value: await safeCount(async () => (await eb.send(new ListRulesCommand({}))).Rules?.length ?? 0) },
      { label: 'Schedules', value: await safeCount(async () => ((await eventbridge.actions.schedules(ctx, {})) as unknown[]).length) },
    ];
  },
  actions: {
    async buses(ctx) {
      return (await ctx.client(EventBridgeClient).send(new ListEventBusesCommand({}))).EventBuses ?? [];
    },
    async createBus(ctx, p) {
      return ctx.client(EventBridgeClient).send(new CreateEventBusCommand({ Name: str(p, 'name') }));
    },
    async deleteBus(ctx, p) {
      await ctx.client(EventBridgeClient).send(new DeleteEventBusCommand({ Name: str(p, 'name') }));
      return { deleted: true };
    },
    async rules(ctx, p) {
      const c = ctx.client(EventBridgeClient);
      const out = [];
      let NextToken: string | undefined;
      do {
        const r = await c.send(new ListRulesCommand({ EventBusName: optStr(p, 'bus') ?? 'default', NextToken }));
        out.push(...(r.Rules ?? []));
        NextToken = r.NextToken;
      } while (NextToken);
      return out;
    },
    async describeRule(ctx, p) {
      return ctx.client(EventBridgeClient).send(new DescribeRuleCommand({ Name: str(p, 'name'), EventBusName: optStr(p, 'bus') }));
    },
    async putRule(ctx, p) {
      const pattern = optStr(p, 'pattern');
      const schedule = optStr(p, 'schedule');
      if (!pattern && !schedule) throw new InputError('Give an event pattern or a schedule expression');
      if (pattern) json(pattern, 'Event pattern');
      return ctx.client(EventBridgeClient).send(
        new PutRuleCommand({
          Name: str(p, 'name'),
          EventBusName: optStr(p, 'bus') ?? 'default',
          EventPattern: pattern,
          ScheduleExpression: schedule,
          State: 'ENABLED',
          Description: optStr(p, 'description'),
        }),
      );
    },
    async deleteRule(ctx, p) {
      const c = ctx.client(EventBridgeClient);
      const Rule = str(p, 'name');
      const EventBusName = optStr(p, 'bus');
      const t = await c.send(new ListTargetsByRuleCommand({ Rule, EventBusName }));
      const ids = (t.Targets ?? []).map((x) => x.Id!);
      if (ids.length) await c.send(new RemoveTargetsCommand({ Rule, EventBusName, Ids: ids }));
      await c.send(new DeleteRuleCommand({ Name: Rule, EventBusName }));
      return { deleted: true, removedTargets: ids.length };
    },
    async setRuleState(ctx, p) {
      const c = ctx.client(EventBridgeClient);
      const input = { Name: str(p, 'name'), EventBusName: optStr(p, 'bus') };
      await c.send(p.enabled ? new EnableRuleCommand(input) : new DisableRuleCommand(input));
      return { ok: true };
    },
    async targets(ctx, p) {
      return (await ctx.client(EventBridgeClient).send(new ListTargetsByRuleCommand({ Rule: str(p, 'name'), EventBusName: optStr(p, 'bus') }))).Targets ?? [];
    },
    async putTarget(ctx, p) {
      const input = optStr(p, 'input');
      if (input) json(input, 'Target input');
      const arn = str(p, 'arn');
      // As the console does: let the rule send to an SQS target (the emulator enforces the queue policy).
      if (arn.startsWith('arn:aws:sqs:') && p.grantQueuePolicy !== false) {
        const rule = await ctx.client(EventBridgeClient).send(new DescribeRuleCommand({ Name: str(p, 'name'), EventBusName: optStr(p, 'bus') }));
        if (rule.Arn) await grantServiceOnQueue(ctx, arn, 'events.amazonaws.com', rule.Arn, `AllowEvents-${rule.Name}`);
      }
      return ctx.client(EventBridgeClient).send(
        new PutTargetsCommand({
          Rule: str(p, 'name'),
          EventBusName: optStr(p, 'bus'),
          Targets: [{ Id: str(p, 'id'), Arn: str(p, 'arn'), Input: input, RoleArn: optStr(p, 'roleArn') }],
        }),
      );
    },
    async removeTarget(ctx, p) {
      return ctx.client(EventBridgeClient).send(new RemoveTargetsCommand({ Rule: str(p, 'name'), EventBusName: optStr(p, 'bus'), Ids: [str(p, 'id')] }));
    },
    async putEvents(ctx, p) {
      const detail = str(p, 'detail');
      json(detail, 'Detail');
      return ctx.client(EventBridgeClient).send(
        new PutEventsCommand({ Entries: [{ EventBusName: optStr(p, 'bus') ?? 'default', Source: str(p, 'source'), DetailType: str(p, 'detailType'), Detail: detail }] }),
      );
    },
    // ---- EventBridge Scheduler
    async scheduleGroups(ctx) {
      return ((await ctx.client(SchedulerClient).send(new ListScheduleGroupsCommand({}))).ScheduleGroups ?? []).filter((g) => inRegion(ctx, g.Arn));
    },
    async schedules(ctx, p) {
      const c = ctx.client(SchedulerClient);
      const out = [];
      let NextToken: string | undefined;
      do {
        const r = await c.send(new ListSchedulesCommand({ GroupName: optStr(p, 'group'), NextToken }));
        out.push(...(r.Schedules ?? []));
        NextToken = r.NextToken;
      } while (NextToken);
      return out.filter((s) => inRegion(ctx, s.Arn));
    },
    async getSchedule(ctx, p) {
      return ctx.client(SchedulerClient).send(new GetScheduleCommand({ Name: str(p, 'name'), GroupName: optStr(p, 'group') }));
    },
    async createSchedule(ctx, p) {
      const input = optStr(p, 'input');
      if (input) json(input, 'Target input');
      return ctx.client(SchedulerClient).send(
        new CreateScheduleCommand({
          Name: str(p, 'name'),
          GroupName: optStr(p, 'group'),
          ScheduleExpression: str(p, 'expression'),
          FlexibleTimeWindow: { Mode: 'OFF' },
          State: 'ENABLED',
          Target: { Arn: str(p, 'targetArn'), RoleArn: await roleOrHelper(ctx, optStr(p, 'roleArn')), Input: input },
        }),
      );
    },
    async deleteSchedule(ctx, p) {
      await ctx.client(SchedulerClient).send(new DeleteScheduleCommand({ Name: str(p, 'name'), GroupName: optStr(p, 'group') }));
      return { deleted: true };
    },
  },
};
