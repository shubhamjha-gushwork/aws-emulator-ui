import {
  LambdaClient, ListFunctionsCommand, GetFunctionCommand, InvokeCommand, DeleteFunctionCommand, CreateFunctionCommand,
  type Runtime,
} from '@aws-sdk/client-lambda';
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import JSZip from 'jszip';
import { type ServiceModule, str, optStr, decodeBytes, safeCount, DEFAULT_ROLE_ARN, InputError } from './types';

const DEFAULT_CODE: Record<string, { file: string; handler: string; code: string }> = {
  'nodejs20.x': {
    file: 'index.mjs',
    handler: 'index.handler',
    code: "export const handler = async (event) => {\n  console.log('event', JSON.stringify(event));\n  return { ok: true, echo: event };\n};\n",
  },
  'python3.12': {
    file: 'lambda_function.py',
    handler: 'lambda_function.handler',
    code: "import json\n\ndef handler(event, context):\n    print('event', json.dumps(event))\n    return {'ok': True, 'echo': event}\n",
  },
};

export async function zipSource(file: string, code: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(file, code);
  return zip.generateAsync({ type: 'uint8array' });
}

export const lambda: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(LambdaClient);
    return [{ label: 'Functions', value: await safeCount(async () => (await c.send(new ListFunctionsCommand({}))).Functions?.length ?? 0) }];
  },
  actions: {
    async list(ctx) {
      const c = ctx.client(LambdaClient);
      const out = [];
      let Marker: string | undefined;
      do {
        const r = await c.send(new ListFunctionsCommand({ Marker }));
        out.push(...(r.Functions ?? []));
        Marker = r.NextMarker;
      } while (Marker);
      return out;
    },
    async get(ctx, p) {
      const r = await ctx.client(LambdaClient).send(new GetFunctionCommand({ FunctionName: str(p, 'name') }));
      return { configuration: r.Configuration, code: r.Code, tags: r.Tags };
    },
    async create(ctx, p) {
      const runtime = str(p, 'runtime') as Runtime;
      const tpl = DEFAULT_CODE[runtime];
      if (!tpl) throw new InputError('Supported quick-create runtimes: nodejs20.x, python3.12');
      const code = optStr(p, 'code') ?? tpl.code;
      return ctx.client(LambdaClient).send(
        new CreateFunctionCommand({
          FunctionName: str(p, 'name'),
          Runtime: runtime,
          Handler: optStr(p, 'handler') ?? tpl.handler,
          Role: optStr(p, 'role') ?? DEFAULT_ROLE_ARN,
          Code: { ZipFile: await zipSource(tpl.file, code) },
          Timeout: 10,
        }),
      );
    },
    async invoke(ctx, p) {
      const payload = optStr(p, 'payload') ?? '{}';
      try {
        JSON.parse(payload);
      } catch {
        throw new InputError('Payload must be valid JSON');
      }
      const r = await ctx.client(LambdaClient).send(
        new InvokeCommand({ FunctionName: str(p, 'name'), Payload: new TextEncoder().encode(payload), LogType: 'Tail' }),
      );
      return {
        statusCode: r.StatusCode,
        functionError: r.FunctionError,
        executedVersion: r.ExecutedVersion,
        payload: decodeBytes(r.Payload),
        logTail: r.LogResult ? Buffer.from(r.LogResult, 'base64').toString('utf8') : '',
      };
    },
    async logs(ctx, p) {
      const group = `/aws/lambda/${str(p, 'name')}`;
      const c = ctx.client(CloudWatchLogsClient);
      const streams = await c.send(new DescribeLogStreamsCommand({ logGroupName: group, orderBy: 'LastEventTime', descending: true, limit: 3 }));
      const events = [];
      for (const s of streams.logStreams ?? []) {
        const r = await c.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: s.logStreamName!, limit: 50, startFromHead: false }));
        events.push(...(r.events ?? []).map((e) => ({ ...e, stream: s.logStreamName })));
      }
      return { group, events: events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)) };
    },
    async delete(ctx, p) {
      await ctx.client(LambdaClient).send(new DeleteFunctionCommand({ FunctionName: str(p, 'name') }));
      return { deleted: true };
    },
  },
};
