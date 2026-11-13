import {
  SNSClient, ListTopicsCommand, GetTopicAttributesCommand, CreateTopicCommand, DeleteTopicCommand,
  ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand, PublishCommand,
} from '@aws-sdk/client-sns';
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { type ServiceModule, type Ctx, str, optStr, bool, safeCount } from './types';

/**
 * Like AWS, the emulator only delivers SNS → SQS when the queue policy lets the topic send.
 * Adds (merges) an Allow statement for this topic into the queue's policy.
 */
export async function grantTopicOnQueue(ctx: Ctx, topicArn: string, queueArn: string) {
  return grantServiceOnQueue(ctx, queueArn, 'sns.amazonaws.com', topicArn, `AllowSns-${topicArn.split(':').pop()}`);
}

/** Add (or replace) a queue-policy statement letting an AWS service send from one source ARN, like the console does. */
export async function grantServiceOnQueue(ctx: Ctx, queueArn: string, service: string, sourceArn: string, sidBase: string) {
  const sqs = ctx.client(SQSClient);
  const [, , , , account, name] = queueArn.split(':');
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name, QueueOwnerAWSAccountId: account }));
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['Policy'] }));
  const policy = attrs.Attributes?.Policy ? JSON.parse(attrs.Attributes.Policy) : { Version: '2012-10-17', Statement: [] };
  const sid = sidBase.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 100);
  policy.Statement = (policy.Statement ?? []).filter((s: { Sid?: string }) => s.Sid !== sid);
  policy.Statement.push({ Sid: sid, Effect: 'Allow', Principal: { Service: service }, Action: 'sqs:SendMessage', Resource: queueArn, Condition: { ArnEquals: { 'aws:SourceArn': sourceArn } } });
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: JSON.stringify(policy) } }));
}

export const sns: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(SNSClient);
    return [{ label: 'Topics', value: await safeCount(async () => (await c.send(new ListTopicsCommand({}))).Topics?.length ?? 0) }];
  },
  actions: {
    async list(ctx) {
      const c = ctx.client(SNSClient);
      const arns: string[] = [];
      let NextToken: string | undefined;
      do {
        const r = await c.send(new ListTopicsCommand({ NextToken }));
        arns.push(...(r.Topics ?? []).map((t) => t.TopicArn!).filter(Boolean));
        NextToken = r.NextToken;
      } while (NextToken);
      return Promise.all(
        arns.map(async (arn) => {
          const a = await c.send(new GetTopicAttributesCommand({ TopicArn: arn })).catch(() => ({ Attributes: {} }));
          return { arn, name: arn.split(':').pop(), attributes: a.Attributes ?? {} };
        }),
      );
    },
    async create(ctx, p) {
      let name = str(p, 'name');
      const fifo = bool(p, 'fifo');
      if (fifo && !name.endsWith('.fifo')) name += '.fifo';
      return ctx.client(SNSClient).send(new CreateTopicCommand({ Name: name, Attributes: fifo ? { FifoTopic: 'true', ContentBasedDeduplication: 'true' } : undefined }));
    },
    async delete(ctx, p) {
      await ctx.client(SNSClient).send(new DeleteTopicCommand({ TopicArn: str(p, 'arn') }));
      return { deleted: true };
    },
    async subscriptions(ctx, p) {
      const r = await ctx.client(SNSClient).send(new ListSubscriptionsByTopicCommand({ TopicArn: str(p, 'arn') }));
      return r.Subscriptions ?? [];
    },
    async subscribe(ctx, p) {
      if (str(p, 'protocol') === 'sqs' && bool(p, 'grantQueuePolicy')) await grantTopicOnQueue(ctx, str(p, 'arn'), str(p, 'endpoint'));
      return ctx.client(SNSClient).send(
        new SubscribeCommand({ TopicArn: str(p, 'arn'), Protocol: str(p, 'protocol'), Endpoint: str(p, 'endpoint'), ReturnSubscriptionArn: true }),
      );
    },
    async unsubscribe(ctx, p) {
      await ctx.client(SNSClient).send(new UnsubscribeCommand({ SubscriptionArn: str(p, 'subscriptionArn') }));
      return { deleted: true };
    },
    async publish(ctx, p) {
      const arn = str(p, 'arn');
      return ctx.client(SNSClient).send(
        new PublishCommand({
          TopicArn: arn,
          Message: str(p, 'message'),
          Subject: optStr(p, 'subject'),
          MessageGroupId: arn.endsWith('.fifo') ? optStr(p, 'groupId') ?? 'default' : undefined,
        }),
      );
    },
  },
};
