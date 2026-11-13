import {
  SQSClient, ListQueuesCommand, GetQueueAttributesCommand, CreateQueueCommand, DeleteQueueCommand, SendMessageCommand,
  ReceiveMessageCommand, DeleteMessageCommand, PurgeQueueCommand, type QueueAttributeName,
} from '@aws-sdk/client-sqs';
import { type ServiceModule, str, optStr, num, bool, safeCount } from './types';

export const sqs: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(SQSClient);
    return [{ label: 'Queues', value: await safeCount(async () => (await c.send(new ListQueuesCommand({}))).QueueUrls?.length ?? 0) }];
  },
  actions: {
    async list(ctx) {
      const c = ctx.client(SQSClient);
      const urls: string[] = [];
      let NextToken: string | undefined;
      do {
        const r = await c.send(new ListQueuesCommand({ NextToken, MaxResults: 1000 }));
        urls.push(...(r.QueueUrls ?? []));
        NextToken = r.NextToken;
      } while (NextToken);
      return Promise.all(
        urls.map(async (url) => {
          const a = await c.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] })).catch(() => ({ Attributes: {} }));
          return { url, name: url.split('/').pop(), attributes: a.Attributes ?? {} };
        }),
      );
    },
    async attributes(ctx, p) {
      const r = await ctx.client(SQSClient).send(new GetQueueAttributesCommand({ QueueUrl: str(p, 'url'), AttributeNames: ['All' as QueueAttributeName] }));
      return r.Attributes ?? {};
    },
    async create(ctx, p) {
      let name = str(p, 'name');
      const fifo = bool(p, 'fifo');
      if (fifo && !name.endsWith('.fifo')) name += '.fifo';
      const Attributes: Record<string, string> = {};
      if (fifo) {
        Attributes.FifoQueue = 'true';
        Attributes.ContentBasedDeduplication = 'true';
      }
      const vt = optStr(p, 'visibilityTimeout');
      if (vt) Attributes.VisibilityTimeout = vt;
      return ctx.client(SQSClient).send(new CreateQueueCommand({ QueueName: name, Attributes }));
    },
    async delete(ctx, p) {
      await ctx.client(SQSClient).send(new DeleteQueueCommand({ QueueUrl: str(p, 'url') }));
      return { deleted: true };
    },
    async send(ctx, p) {
      const url = str(p, 'url');
      return ctx.client(SQSClient).send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: str(p, 'body'),
          MessageGroupId: url.endsWith('.fifo') ? optStr(p, 'groupId') ?? 'default' : undefined,
          DelaySeconds: url.endsWith('.fifo') ? undefined : num(p, 'delaySeconds', 0),
        }),
      );
    },
    async receive(ctx, p) {
      const r = await ctx.client(SQSClient).send(
        new ReceiveMessageCommand({
          QueueUrl: str(p, 'url'),
          MaxNumberOfMessages: Math.min(10, Math.max(1, num(p, 'max', 10))),
          VisibilityTimeout: num(p, 'visibilityTimeout', 30),
          WaitTimeSeconds: Math.min(5, num(p, 'waitSeconds', 1)),
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      return r.Messages ?? [];
    },
    async deleteMessage(ctx, p) {
      await ctx.client(SQSClient).send(new DeleteMessageCommand({ QueueUrl: str(p, 'url'), ReceiptHandle: str(p, 'receiptHandle') }));
      return { deleted: true };
    },
    async purge(ctx, p) {
      await ctx.client(SQSClient).send(new PurgeQueueCommand({ QueueUrl: str(p, 'url') }));
      return { purged: true };
    },
  },
};
