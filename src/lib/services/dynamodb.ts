import {
  DynamoDBClient, ListTablesCommand, DescribeTableCommand, CreateTableCommand, DeleteTableCommand, ScanCommand,
  PutItemCommand, DeleteItemCommand, type AttributeValue, type ScalarAttributeType, type KeySchemaElement, type AttributeDefinition,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { type ServiceModule, str, optStr, num, json, safeCount, InputError } from './types';

/** Accepts a plain JSON object and returns DynamoDB AttributeValues. */
export function toItem(text: string): Record<string, AttributeValue> {
  const obj = json(text, 'Item');
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new InputError('Item must be a JSON object');
  return marshall(obj as Record<string, unknown>, { removeUndefinedValues: true, convertClassInstanceToMap: false });
}

export const dynamodb: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(DynamoDBClient);
    return [{ label: 'Tables', value: await safeCount(async () => (await c.send(new ListTablesCommand({}))).TableNames?.length ?? 0) }];
  },
  actions: {
    async list(ctx) {
      const c = ctx.client(DynamoDBClient);
      const names: string[] = [];
      let ExclusiveStartTableName: string | undefined;
      do {
        const r = await c.send(new ListTablesCommand({ ExclusiveStartTableName }));
        names.push(...(r.TableNames ?? []));
        ExclusiveStartTableName = r.LastEvaluatedTableName;
      } while (ExclusiveStartTableName);
      return Promise.all(names.map(async (n) => (await c.send(new DescribeTableCommand({ TableName: n }))).Table));
    },
    async describe(ctx, p) {
      return (await ctx.client(DynamoDBClient).send(new DescribeTableCommand({ TableName: str(p, 'name') }))).Table;
    },
    async create(ctx, p) {
      const pk = str(p, 'pk');
      const sk = optStr(p, 'sk');
      const KeySchema: KeySchemaElement[] = [{ AttributeName: pk, KeyType: 'HASH' }];
      const AttributeDefinitions: AttributeDefinition[] = [{ AttributeName: pk, AttributeType: (optStr(p, 'pkType') ?? 'S') as ScalarAttributeType }];
      if (sk) {
        KeySchema.push({ AttributeName: sk, KeyType: 'RANGE' });
        AttributeDefinitions.push({ AttributeName: sk, AttributeType: (optStr(p, 'skType') ?? 'S') as ScalarAttributeType });
      }
      const r = await ctx.client(DynamoDBClient).send(
        new CreateTableCommand({ TableName: str(p, 'name'), KeySchema, AttributeDefinitions, BillingMode: 'PAY_PER_REQUEST' }),
      );
      return r.TableDescription;
    },
    async delete(ctx, p) {
      await ctx.client(DynamoDBClient).send(new DeleteTableCommand({ TableName: str(p, 'name') }));
      return { deleted: true };
    },
    async scan(ctx, p) {
      const start = optStr(p, 'startKey');
      const r = await ctx.client(DynamoDBClient).send(
        new ScanCommand({ TableName: str(p, 'name'), Limit: num(p, 'limit', 50), ExclusiveStartKey: start ? (JSON.parse(start) as Record<string, AttributeValue>) : undefined }),
      );
      return {
        items: (r.Items ?? []).map((i) => unmarshall(i)),
        count: r.Count,
        scannedCount: r.ScannedCount,
        lastKey: r.LastEvaluatedKey ? JSON.stringify(r.LastEvaluatedKey) : undefined,
      };
    },
    async putItem(ctx, p) {
      await ctx.client(DynamoDBClient).send(new PutItemCommand({ TableName: str(p, 'name'), Item: toItem(str(p, 'item')) }));
      return { ok: true };
    },
    async deleteItem(ctx, p) {
      await ctx.client(DynamoDBClient).send(new DeleteItemCommand({ TableName: str(p, 'name'), Key: toItem(str(p, 'key')) }));
      return { deleted: true };
    },
  },
};
