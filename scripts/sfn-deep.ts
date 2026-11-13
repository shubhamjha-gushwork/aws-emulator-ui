/**
 * Step Functions deep test through the UI's API routes (same calls the Step Functions page makes).
 * Creates uitest-* state machines, a Lambda, a queue, a topic and a table in the UI's current region,
 * exercises every state type and the SQS/SNS/DynamoDB/Lambda integrations, then deletes everything.
 *
 *   npm run sfn-deep        # UI_URL defaults to http://127.0.0.1:3297, PREFIX to "uitest"
 */
import { mkdirSync, writeFileSync } from 'fs';

const UI = process.env.UI_URL || 'http://127.0.0.1:3297';
const P = `${process.env.PREFIX || 'uitest'}-sfn-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Res = { feature: string; ok: boolean; note?: string };
const results: Res[] = [];

async function call<T = unknown>(service: string, action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${UI}/api/aws/${service}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const body = (await r.json()) as { data?: T; error?: { name: string; message: string } };
  if (body.error) throw new Error(`${body.error.name}: ${body.error.message}`);
  return body.data as T;
}

async function feature(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    results.push({ feature: name, ok: true, note: note || undefined });
    console.log(`  ✓ ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    results.push({ feature: name, ok: false, note: (e as Error).message });
    console.log(`  ✗ ${name} — ${(e as Error).message.slice(0, 300)}`);
  }
}

type Exec = { status: string; output?: string; error?: string; cause?: string };
const machines: string[] = [];

async function machine(suffix: string, def: object, type: 'STANDARD' | 'EXPRESS' = 'STANDARD') {
  const r = await call<{ stateMachineArn: string }>('stepfunctions', 'create', { name: `${P}-${suffix}`, definition: JSON.stringify(def), type });
  machines.push(r.stateMachineArn);
  return r.stateMachineArn;
}

async function run(arn: string, input: object = {}, timeoutMs = 20000): Promise<Exec & { executionArn: string }> {
  const { executionArn } = await call<{ executionArn: string }>('stepfunctions', 'start', { arn, input: JSON.stringify(input) });
  const end = Date.now() + timeoutMs;
  for (;;) {
    const d = await call<Exec>('stepfunctions', 'describeExecution', { executionArn });
    if (d.status !== 'RUNNING' || Date.now() > end) return { ...d, executionArn };
    await sleep(400);
  }
}

function expectOk(e: Exec, check?: (out: Record<string, unknown>) => boolean) {
  if (e.status !== 'SUCCEEDED') throw new Error(`${e.status}${e.error ? ` ${e.error}: ${e.cause}` : ''}`);
  const out = JSON.parse(e.output ?? 'null');
  if (check && !check(out)) throw new Error(`unexpected output ${e.output}`);
  return `output ${(e.output ?? '').slice(0, 120)}`;
}

async function main() {
  const status = (await (await fetch(`${UI}/api/status`)).json()) as { region: string; health: { ok: boolean } };
  if (!status.health.ok) throw new Error('Emulator not healthy');
  const region = status.region;
  console.log(`Step Functions deep test on ${UI}, region ${region}, prefix ${P}`);

  // Fixtures
  const fn = `${P}-fn`;
  await call('lambda', 'create', { name: fn, runtime: 'nodejs20.x', code: "export const handler = async (event) => ({ ok: true, doubled: (event.n ?? 0) * 2, echo: event });\n" });
  const fnArn = (await call<{ configuration: { FunctionArn: string } }>('lambda', 'get', { name: fn })).configuration.FunctionArn;
  const q = await call<{ QueueUrl: string }>('sqs', 'create', { name: `${P}-q` });
  const topic = await call<{ TopicArn: string }>('sns', 'create', { name: `${P}-t` });
  const tbl = `${P}-tbl`;
  await call('dynamodb', 'create', { name: tbl, pk: 'pk' });
  for (let i = 0; i < 20 && (await call<{ TableStatus: string }>('dynamodb', 'describe', { name: tbl })).TableStatus !== 'ACTIVE'; i++) await sleep(250);

  await feature('STANDARD: Pass (Result + ResultPath)', async () => {
    const a = await machine('pass', { StartAt: 'P', States: { P: { Type: 'Pass', Result: { hello: 'world' }, ResultPath: '$.greeting', End: true } } });
    return expectOk(await run(a, { x: 1 }), (o) => (o.greeting as { hello: string })?.hello === 'world' && o.x === 1);
  });
  await feature('Task: arn:aws:states:::lambda:invoke (optimized)', async () => {
    const a = await machine('lambda-opt', { StartAt: 'T', States: { T: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Parameters: { FunctionName: fnArn, 'Payload.$': '$' }, OutputPath: '$.Payload', End: true } } });
    return expectOk(await run(a, { n: 21 }), (o) => o.doubled === 42);
  });
  await feature('Task: direct Lambda ARN', async () => {
    const a = await machine('lambda-direct', { StartAt: 'T', States: { T: { Type: 'Task', Resource: fnArn, End: true } } });
    return expectOk(await run(a, { n: 5 }), (o) => o.doubled === 10);
  });
  await feature('Choice + Wait + Succeed', async () => {
    const a = await machine('choice', { StartAt: 'C', States: {
      C: { Type: 'Choice', Choices: [{ Variable: '$.n', NumericGreaterThan: 10, Next: 'Big' }], Default: 'Small' },
      Big: { Type: 'Wait', Seconds: 1, Next: 'Done' },
      Small: { Type: 'Pass', Result: 'small', ResultPath: '$.size', Next: 'Done' },
      Done: { Type: 'Succeed' } } });
    const big = await run(a, { n: 50 });
    const small = await run(a, { n: 1 });
    expectOk(small, (o) => o.size === 'small');
    return expectOk(big, (o) => o.n === 50 && !('size' in o)) + '; small branch ok';
  });
  await feature('Parallel', async () => {
    const a = await machine('parallel', { StartAt: 'Par', States: { Par: { Type: 'Parallel', End: true, Branches: [
      { StartAt: 'A', States: { A: { Type: 'Pass', Result: 'a', End: true } } },
      { StartAt: 'B', States: { B: { Type: 'Task', Resource: fnArn, End: true } } }] } } });
    return expectOk(await run(a, { n: 2 }), (o) => Array.isArray(o) && o[0] === 'a' && (o[1] as { doubled: number }).doubled === 4);
  });
  await feature('Map (ItemProcessor, Lambda per item)', async () => {
    const a = await machine('map', { StartAt: 'M', States: { M: { Type: 'Map', ItemsPath: '$.items', MaxConcurrency: 2, End: true,
      ItemProcessor: { ProcessorConfig: { Mode: 'INLINE' }, StartAt: 'D', States: { D: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Parameters: { FunctionName: fnArn, 'Payload.$': '$' }, OutputPath: '$.Payload.doubled', End: true } } } } } });
    return expectOk(await run(a, { items: [{ n: 1 }, { n: 2 }, { n: 3 }] }), (o) => JSON.stringify(o) === '[2,4,6]');
  });
  await feature('Fail state', async () => {
    const a = await machine('fail', { StartAt: 'F', States: { F: { Type: 'Fail', Error: 'Custom.Bad', Cause: 'on purpose' } } });
    const e = await run(a);
    if (e.status !== 'FAILED' || e.error !== 'Custom.Bad' || e.cause !== 'on purpose') throw new Error(`${e.status} ${e.error} ${e.cause}`);
    return 'FAILED Custom.Bad: on purpose';
  });
  await feature('Retry + Catch (missing Lambda)', async () => {
    const a = await machine('retry', { StartAt: 'T', States: {
      T: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Parameters: { FunctionName: `${P}-does-not-exist` }, Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 1, MaxAttempts: 1, BackoffRate: 1 }], Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.err', Next: 'Recovered' }], End: true },
      Recovered: { Type: 'Pass', Result: true, ResultPath: '$.recovered', End: true } } });
    const e = await run(a, {}, 30000);
    const note = expectOk(e, (o) => o.recovered === true && !!o.err);
    const h = await call<{ type: string }[]>('stepfunctions', 'history', { executionArn: e.executionArn });
    const fails = h.filter((x) => /TaskFailed|LambdaFunctionFailed/.test(x.type)).length;
    if (fails < 2) throw new Error(`expected a retry (2 failures in history), saw ${fails}`);
    return `${note}; ${fails} failed attempts in history`;
  });
  await feature('Integration: sqs:sendMessage', async () => {
    const a = await machine('sqs', { StartAt: 'S', States: { S: { Type: 'Task', Resource: 'arn:aws:states:::sqs:sendMessage', Parameters: { QueueUrl: q.QueueUrl, 'MessageBody.$': '$' }, End: true } } });
    const note = expectOk(await run(a, { order: 7 }));
    const m = await call<{ Body: string }[]>('sqs', 'receive', { url: q.QueueUrl, waitSeconds: 2 });
    if (!m.some((x) => x.Body.includes('"order":7'))) throw new Error('message not in queue');
    return `${note}; message received from queue`;
  });
  await feature('Integration: sns:publish (string Message)', async () => {
    const a = await machine('sns', { StartAt: 'S', States: { S: { Type: 'Task', Resource: 'arn:aws:states:::sns:publish', Parameters: { TopicArn: topic.TopicArn, 'Message.$': 'States.JsonToString($)' }, End: true } } });
    return expectOk(await run(a, { hi: 1 }), (o) => !!o.MessageId);
  });
  await feature('Integration: sns:publish (JSON object Message)', async () => {
    const a = await machine('sns-obj', { StartAt: 'S', States: { S: { Type: 'Task', Resource: 'arn:aws:states:::sns:publish', Parameters: { TopicArn: topic.TopicArn, 'Message.$': '$' }, End: true } } });
    return expectOk(await run(a, { hi: 1 }), (o) => !!o.MessageId);
  });
  await feature('Integration: dynamodb:putItem + getItem', async () => {
    const a = await machine('ddb', { StartAt: 'Put', States: {
      Put: { Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem', Parameters: { TableName: tbl, Item: { pk: { 'S.$': '$.id' }, v: { S: 'from-sfn' } } }, ResultPath: null, Next: 'Get' },
      Get: { Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem', Parameters: { TableName: tbl, Key: { pk: { 'S.$': '$.id' } } }, End: true } } });
    const note = expectOk(await run(a, { id: 'k1' }), (o) => (o.Item as { v?: { S: string } })?.v?.S === 'from-sfn');
    const scan = await call<{ items: { pk: string }[] }>('dynamodb', 'scan', { name: tbl });
    if (!scan.items.some((i) => i.pk === 'k1')) throw new Error('item not in table');
    return note;
  });
  let waitArn = '';
  await feature('History renders (events for an execution)', async () => {
    const a = machines[0];
    const e = await run(a, { x: 2 });
    const h = await call<{ type: string }[]>('stepfunctions', 'history', { executionArn: e.executionArn });
    if (!h.some((x) => x.type === 'ExecutionStarted') || !h.some((x) => x.type === 'ExecutionSucceeded')) throw new Error(h.map((x) => x.type).join(','));
    return `${h.length} events: ${h.map((x) => x.type).join(' → ')}`;
  });
  await feature('Stop execution (ABORTED)', async () => {
    waitArn = await machine('wait', { StartAt: 'W', States: { W: { Type: 'Wait', Seconds: 120, End: true } } });
    const { executionArn } = await call<{ executionArn: string }>('stepfunctions', 'start', { arn: waitArn, input: '{}' });
    await sleep(500);
    await call('stepfunctions', 'stop', { executionArn });
    await sleep(300);
    const d = await call<Exec>('stepfunctions', 'describeExecution', { executionArn });
    if (d.status !== 'ABORTED') throw new Error(d.status);
    return 'ABORTED';
  });
  await feature('List executions', async () => {
    const l = await call<{ status: string }[]>('stepfunctions', 'executions', { arn: waitArn });
    if (!l.some((x) => x.status === 'ABORTED')) throw new Error(JSON.stringify(l));
    return `${l.length} execution(s)`;
  });
  await feature('Update state machine definition', async () => {
    await call('stepfunctions', 'update', { arn: machines[0], definition: JSON.stringify({ StartAt: 'P2', States: { P2: { Type: 'Pass', Result: 'v2', End: true } } }) });
    const d = await call<{ definition: string }>('stepfunctions', 'describe', { arn: machines[0] });
    if (!d.definition.includes('P2')) throw new Error('definition not updated');
    return expectOk(await run(machines[0]), (o) => (o as unknown) === 'v2');
  });
  await feature('EXPRESS: StartSyncExecution', async () => {
    const a = await machine('express', { StartAt: 'T', States: { T: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Parameters: { FunctionName: fnArn, 'Payload.$': '$' }, OutputPath: '$.Payload', End: true } } }, 'EXPRESS');
    const r = await call<Exec>('stepfunctions', 'startSync', { arn: a, input: JSON.stringify({ n: 4 }) });
    return expectOk(r, (o) => o.doubled === 8);
  });
  await feature('EXPRESS: async StartExecution', async () => {
    const a = machines[machines.length - 1];
    const r = await call<{ executionArn: string }>('stepfunctions', 'start', { arn: a, input: '{"n":1}' });
    return `started ${r.executionArn.split(':').slice(-2).join(':')} (EXPRESS executions are not listed/described, as on AWS)`;
  });
  await feature('Definition steps view data (DescribeStateMachine)', async () => {
    const d = await call<{ definition: string; type: string }>('stepfunctions', 'describe', { arn: machines.find((m) => m.endsWith('-retry'))! });
    const def = JSON.parse(d.definition) as { States: Record<string, { Retry?: unknown; Catch?: unknown }> };
    if (!def.States.T.Retry || !def.States.T.Catch) throw new Error('Retry/Catch missing');
    return `${Object.keys(def.States).length} states incl. Retry/Catch`;
  });
  await feature('Delete state machines', async () => {
    for (const m of machines.splice(0)) await call('stepfunctions', 'delete', { arn: m });
    // DeleteStateMachine is asynchronous (DELETING first), as on AWS
    let left: { name: string }[] = [];
    for (let i = 0; i < 30; i++) {
      left = (await call<{ name: string }[]>('stepfunctions', 'list')).filter((m) => m.name.startsWith(P));
      if (!left.length) return 'gone from the list';
      await sleep(500);
    }
    throw new Error(`still listed after 15 s: ${left.map((m) => m.name).join(', ')}`);
  });

  // cleanup fixtures
  for (const m of machines) await call('stepfunctions', 'delete', { arn: m }).catch(() => undefined);
  await call('lambda', 'delete', { name: fn }).catch(() => undefined);
  await call('logs', 'deleteGroup', { name: `/aws/lambda/${fn}` }).catch(() => undefined);
  await call('sqs', 'delete', { url: q.QueueUrl }).catch(() => undefined);
  await call('sns', 'delete', { arn: topic.TopicArn }).catch(() => undefined);
  await call('dynamodb', 'delete', { name: tbl }).catch(() => undefined);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Step Functions features passed (${region}).`);
  mkdirSync('.data', { recursive: true });
  writeFileSync(`.data/sfn-deep-${region}.json`, JSON.stringify({ at: new Date().toISOString(), region, results }, null, 2));
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
