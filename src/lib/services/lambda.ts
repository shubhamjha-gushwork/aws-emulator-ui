import {
  LambdaClient, ListFunctionsCommand, GetFunctionCommand, InvokeCommand, DeleteFunctionCommand, CreateFunctionCommand,
  type Runtime,
} from '@aws-sdk/client-lambda';
import {
  CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { capturedStreamName, isUiCapturedStream } from '../log-sources';
import JSZip from 'jszip';
import { type Ctx, type ServiceModule, str, optStr, bool, decodeBytes, safeCount, InputError, inRegion } from './types';
import { roleOrHelper } from './iam-role';

/**
 * AWS Emulator writes Lambda output to /aws/lambda/<fn> itself, but only when the function's execution role allows
 * logs:CreateLogGroup/CreateLogStream/PutLogEvents (as on AWS). The UI helper role does. For functions whose role
 * doesn't, invoking from the UI copies the Invoke log tail (last 4 KB) into /aws/lambda/<fn>, in a stream whose name
 * contains "captured-by-ui". Skipped when the emulator already wrote streams to that group.
 *
 * Floci (and some emulator cases) may return an empty Invoke LogType=Tail. In that case we read the
 * same group and use those events as the log tail shown in the UI.
 */
async function logsFromGroup(ctx: Ctx, fn: string): Promise<string> {
  const group = `/aws/lambda/${fn}`;
  const c = ctx.client(CloudWatchLogsClient);
  try {
    const streams = await c.send(new DescribeLogStreamsCommand({ logGroupName: group, orderBy: 'LastEventTime', descending: true, limit: 3 }));
    const events: { timestamp?: number; message?: string }[] = [];
    for (const s of streams.logStreams ?? []) {
      const r = await c.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: s.logStreamName!, limit: 80, startFromHead: false }));
      events.push(...(r.events ?? []));
    }
    events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return events.map((e) => e.message ?? '').join('');
  } catch (e) {
    if ((e as Error).name === 'ResourceNotFoundException') return '';
    throw e;
  }
}

async function logTailFromCloudWatch(ctx: Ctx, fn: string): Promise<string> {
  // Floci writes the stream shortly after Invoke returns.
  for (let i = 0; i < 20; i++) {
    const text = await logsFromGroup(ctx, fn);
    if (text.includes('START') || text.includes('REPORT') || text.trim().length > 0) return text;
    await new Promise((r) => setTimeout(r, 400));
  }
  return '';
}

async function captureLogTail(ctx: Ctx, fn: string, version: string | undefined, tail: string) {
  const lines = tail.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (!lines.length) return undefined;
  const c = ctx.client(CloudWatchLogsClient);
  const group = `/aws/lambda/${fn}`;
  try {
    await c.send(new CreateLogGroupCommand({ logGroupName: group }));
  } catch (e) {
    if ((e as Error).name !== 'ResourceAlreadyExistsException') throw e;
    const existing = (await c.send(new DescribeLogStreamsCommand({ logGroupName: group, limit: 50 }))).logStreams ?? [];
    if (existing.some((s) => !isUiCapturedStream(s.logStreamName))) return { group, skipped: 'emulator writes this group itself' };
  }
  const requestId = /RequestId:\s*([0-9a-f-]+)/i.exec(tail)?.[1] ?? crypto.randomUUID();
  const stream = capturedStreamName(version, requestId);
  await c.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: stream }));
  const now = Date.now();
  await c.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: stream, logEvents: lines.map((message) => ({ timestamp: now, message })) }));
  return { group, stream };
}

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
    return [{ label: 'Functions', value: await safeCount(async () => ((await lambda.actions.list(ctx, {})) as unknown[]).length) }];
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
      return out.filter((f) => inRegion(ctx, f.FunctionArn));
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
      const c = ctx.client(LambdaClient);
      const created = await c.send(
        new CreateFunctionCommand({
          FunctionName: str(p, 'name'),
          Runtime: runtime,
          Handler: optStr(p, 'handler') ?? tpl.handler,
          Role: await roleOrHelper(ctx, optStr(p, 'role')),
          Code: { ZipFile: await zipSource(tpl.file, code) },
          Timeout: 10,
        }),
      );
      // New functions start Pending (as on AWS) and Invoke is refused until they're Active; wait briefly.
      for (let i = 0; i < 40 && created.State === 'Pending'; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const cfg = (await c.send(new GetFunctionCommand({ FunctionName: created.FunctionName }))).Configuration;
        if (cfg?.State && cfg.State !== 'Pending') return cfg;
      }
      return created;
    },
    async invoke(ctx, p) {
      const payload = optStr(p, 'payload') ?? '{}';
      try {
        JSON.parse(payload);
      } catch {
        throw new InputError('Payload must be valid JSON');
      }
      const name = str(p, 'name');
      const send = () => ctx.client(LambdaClient).send(new InvokeCommand({ FunctionName: name, Payload: new TextEncoder().encode(payload), LogType: 'Tail' }));
      let r: Awaited<ReturnType<typeof send>> | undefined;
      for (let i = 0; !r; i++) {
        try {
          r = await send();
        } catch (e) {
          // a just-created function is Pending for a moment
          if (i >= 20 || (e as Error).name !== 'ResourceConflictException' || !/Pending/.test((e as Error).message)) throw e;
          await new Promise((res) => setTimeout(res, 250));
        }
      }
      let logTail = r.LogResult ? Buffer.from(r.LogResult, 'base64').toString('utf8') : '';
      if (!logTail.trim()) logTail = await logTailFromCloudWatch(ctx, name);
      let captured: Awaited<ReturnType<typeof captureLogTail>>;
      let captureError: string | undefined;
      if (p.capture === undefined || bool(p, 'capture')) {
        try {
          captured = await captureLogTail(ctx, name, r.ExecutedVersion, logTail);
        } catch (e) {
          captureError = (e as Error).message;
        }
      }
      return {
        statusCode: r.StatusCode,
        functionError: r.FunctionError,
        executedVersion: r.ExecutedVersion,
        payload: decodeBytes(r.Payload),
        logTail,
        captured,
        captureError,
      };
    },
    async logs(ctx, p) {
      const group = `/aws/lambda/${str(p, 'name')}`;
      const c = ctx.client(CloudWatchLogsClient);
      const streams = await c.send(new DescribeLogStreamsCommand({ logGroupName: group, orderBy: 'LastEventTime', descending: true, limit: 3 }));
      const events = [];
      for (const s of streams.logStreams ?? []) {
        const r = await c.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: s.logStreamName!, limit: 50, startFromHead: false }));
        events.push(...(r.events ?? []).map((e) => ({ ...e, stream: s.logStreamName, capturedByUi: isUiCapturedStream(s.logStreamName) })));
      }
      return { group, events: events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)) };
    },
    async delete(ctx, p) {
      await ctx.client(LambdaClient).send(new DeleteFunctionCommand({ FunctionName: str(p, 'name') }));
      return { deleted: true };
    },
  },
};
