'use client';

import { useState } from 'react';
import { LuPencil, LuPlay, LuPlus, LuSquare, LuTrash2 } from 'react-icons/lu';
import { StateGraph } from '@/components/StateGraph';
import { useStatus } from '@/components/AppShell';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, ConfirmDialog, Empty, Field, Input, JsonBlock, KV, Modal, Mono, Pill, Segmented, Select, Spinner, StatusPill, Textarea, TimeAgo } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface SM { stateMachineArn: string; name: string; type?: string; creationDate?: string }
interface Exec { executionArn: string; name: string; status: string; startDate?: string; stopDate?: string }
interface HistEvent { id: number; type: string; timestamp?: string; previousEventId?: number; [k: string]: unknown }

const fnArn = (region: string, name: string) => `arn:aws:lambda:${region}:000000000000:function:${name}`;
/** Starter definitions for the create dialog. */
const TEMPLATES: Record<string, { label: string; def: (region: string) => object }> = {
  hello: {
    label: 'Hello world (Pass)',
    def: () => ({ Comment: 'Hello world', StartAt: 'Greet', States: { Greet: { Type: 'Pass', Result: { message: 'hello' }, ResultPath: '$.greeting', Next: 'Done' }, Done: { Type: 'Succeed' } } }),
  },
  lambda: {
    label: 'Invoke a Lambda',
    def: (r) => ({
      Comment: 'Calls demo-hello through the optimized integration, then directly by ARN',
      StartAt: 'Invoke',
      States: {
        Invoke: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Parameters: { FunctionName: fnArn(r, 'demo-hello'), 'Payload.$': '$' }, ResultSelector: { 'body.$': '$.Payload' }, ResultPath: '$.first', Next: 'Direct' },
        Direct: { Type: 'Task', Resource: fnArn(r, 'demo-hello'), ResultPath: '$.second', End: true },
      },
    }),
  },
  choice: {
    label: 'Choice + Wait',
    def: () => ({
      StartAt: 'Check',
      States: {
        Check: { Type: 'Choice', Choices: [{ Variable: '$.amount', NumericGreaterThan: 100, Next: 'Review' }], Default: 'Approve' },
        Review: { Type: 'Wait', Seconds: 2, Next: 'Approve' },
        Approve: { Type: 'Pass', Result: 'approved', ResultPath: '$.decision', Next: 'Done' },
        Done: { Type: 'Succeed' },
      },
    }),
  },
  parallel: {
    label: 'Parallel + Map',
    def: () => ({
      StartAt: 'Fan out',
      States: {
        'Fan out': {
          Type: 'Parallel', ResultPath: '$.parallel', Next: 'Each item',
          Branches: [
            { StartAt: 'A', States: { A: { Type: 'Pass', Result: 'a', End: true } } },
            { StartAt: 'B', States: { B: { Type: 'Pass', Result: 'b', End: true } } },
          ],
        },
        'Each item': {
          Type: 'Map', ItemsPath: '$.items', ResultPath: '$.mapped', End: true,
          ItemProcessor: { ProcessorConfig: { Mode: 'INLINE' }, StartAt: 'Tag', States: { Tag: { Type: 'Pass', Parameters: { 'item.$': '$', processed: true }, End: true } } },
        },
      },
    }),
  },
  retry: {
    label: 'Retry + Catch',
    def: (r) => ({
      StartAt: 'Call',
      States: {
        Call: {
          Type: 'Task', Resource: fnArn(r, 'does-not-exist'), Next: 'Done',
          Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 1, MaxAttempts: 1, BackoffRate: 1 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'Recovered' }],
        },
        Recovered: { Type: 'Pass', Result: 'handled', ResultPath: '$.recovery', Next: 'Done' },
        Done: { Type: 'Succeed' },
      },
    }),
  },
  fail: { label: 'Fail', def: () => ({ StartAt: 'Boom', States: { Boom: { Type: 'Fail', Error: 'OrderRejected', Cause: 'Amount over limit' } } }) },
};
const tpl = (key: string, region: string) => JSON.stringify(TEMPLATES[key].def(region), null, 2);

export default function StepFunctionsPage() {
  const list = useAws<SM[]>('stepfunctions', 'list');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = list.data?.find((s) => s.stateMachineArn === sel) ?? null;
  return (
    <>
      <PageHeader serviceId="stepfunctions" actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create state machine</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
        <ListCard title="State machines" subtitle={list.data ? `${list.data.length} total` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListStateMachines">
          <DataTable
            rows={list.data ?? []}
            rowKey={(s) => s.stateMachineArn}
            selectedKey={sel}
            onRowClick={(s) => setSel(s.stateMachineArn)}
            empty="No state machines yet."
            columns={[
              { key: 'n', header: 'Name', cell: (s) => <span className="font-medium text-neutral-900">{s.name}</span> },
              { key: 't', header: 'Type', cell: (s) => <Pill tone="blue">{s.type ?? 'STANDARD'}</Pill> },
              { key: 'c', header: 'Created', cell: (s) => <span className="text-neutral-500"><TimeAgo value={s.creationDate} /></span> },
            ]}
          />
        </ListCard>
        {selected ? <MachineDetail key={selected.stateMachineArn} sm={selected} onDeleted={() => { setSel(null); void list.reload(); }} /> : (
          <ListCard title="State machine details"><Empty>Select a state machine to run it and inspect executions.</Empty></ListCard>
        )}
      </div>
      <CreateMachine open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void list.reload(); }} />
    </>
  );
}

function MachineDetail({ sm, onDeleted }: { sm: SM; onDeleted: () => void }) {
  const desc = useAws<{ definition?: string; roleArn?: string; status?: string }>('stepfunctions', 'describe', { arn: sm.stateMachineArn });
  const express = sm.type === 'EXPRESS';
  // EXPRESS executions aren't listed or described by Step Functions (as on AWS); run them synchronously instead.
  const execs = useAws<Exec[]>('stepfunctions', 'executions', express ? null : { arn: sm.stateMachineArn });
  const [view, setView] = useState<'steps' | 'json'>('steps');
  const [editing, setEditing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ status?: string; output?: string; error?: string; cause?: string } | null>(null);
  const [input, setInput] = useState('{\n  "orderId": "o-1"\n}');
  const [exec, setExec] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const m = useMutation();
  return (
    <ListCard
      title={sm.name}
      subtitle={<Mono className="text-neutral-500">{sm.stateMachineArn}</Mono>}
      actions={<Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>}
    >
      <div className="flex flex-col gap-6 px-5 py-5">
        <KV items={[['Status', <StatusPill key="s" status={desc.data?.status} />], ['Role', <Mono key="r">{desc.data?.roleArn}</Mono>]]} />
        <Section
          title="Definition"
          actions={
            <div className="flex items-center gap-2">
              <Segmented value={view} onChange={setView} options={[{ value: 'steps', label: 'Steps' }, { value: 'json', label: 'JSON' }]} />
              <Button size="sm" onClick={() => setEditing(true)} disabled={!desc.data}><LuPencil /> Edit</Button>
            </div>
          }
        >
          {desc.error ? <ErrorState error={desc.error} compact /> : desc.data ? (view === 'steps' ? <StateGraph definition={desc.data.definition ?? ''} /> : <JsonBlock value={desc.data.definition ?? ''} maxHeight={320} />) : <Spinner />}
        </Section>
        <Section title="Start execution">
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} aria-label="Execution input" />
          <div>
            <Button
              variant="primary"
              loading={m.busy}
              data-testid="start-execution"
              onClick={async () => {
                if (express) {
                  const r = await m.run<{ status?: string; output?: string; error?: string; cause?: string }>('stepfunctions', 'startSync', { arn: sm.stateMachineArn, input }, 'Express execution finished');
                  if (r) setSyncResult(r);
                  return;
                }
                const r = await m.run<{ executionArn: string }>('stepfunctions', 'start', { arn: sm.stateMachineArn, input }, 'Execution started');
                if (r) { setExec(r.executionArn); setTimeout(() => void execs.reload(), 700); }
              }}
            >
              <LuPlay /> {express ? 'Run (sync)' : 'Start'}
            </Button>
          </div>
          <InlineError error={m.error} />
          {syncResult ? (
            <div className="flex flex-col gap-1.5" data-testid="sync-result">
              <div className="flex items-center gap-2"><StatusPill status={syncResult.status} /><span className="text-xs text-neutral-500">StartSyncExecution</span></div>
              <JsonBlock value={syncResult.error ? `${syncResult.error}: ${syncResult.cause ?? ''}` : syncResult.output ?? ''} maxHeight={200} />
            </div>
          ) : null}
        </Section>
        {express ? (
          <p className="text-sm text-neutral-500">Express workflows don&apos;t keep an execution list or history in Step Functions; each run&apos;s result shows above.</p>
        ) : (
        <Section title="Executions" actions={<Button size="sm" variant="ghost" onClick={execs.reload}>Refresh</Button>}>
          {execs.error ? <ErrorState error={execs.error} compact what="ListExecutions" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable
                rows={execs.data ?? []}
                rowKey={(e) => e.executionArn}
                selectedKey={exec}
                onRowClick={(e) => setExec(e.executionArn)}
                empty="No executions yet."
                columns={[
                  { key: 'n', header: 'Name', cell: (e) => <Mono className="truncate">{e.name}</Mono>, className: 'max-w-56 truncate' },
                  { key: 's', header: 'Status', cell: (e) => <StatusPill status={e.status} /> },
                  { key: 'd', header: 'Started', cell: (e) => <span className="text-neutral-500"><TimeAgo value={e.startDate} /></span> },
                ]}
              />
            </div>
          )}
        </Section>
        )}
        {exec && !express ? <ExecutionDetail key={exec} arn={exec} onChanged={execs.reload} /> : null}
      </div>
      {editing && desc.data ? <EditMachine arn={sm.stateMachineArn} initial={desc.data.definition ?? ''} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void desc.reload(); }} /> : null}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${sm.name}?`} description="The state machine is deleted. Running executions are stopped." busy={m.busy} onConfirm={async () => { if (await m.run('stepfunctions', 'delete', { arn: sm.stateMachineArn }, `Deleted ${sm.name}`)) { setConfirm(false); onDeleted(); } }} />
    </ListCard>
  );
}

function ExecutionDetail({ arn, onChanged }: { arn: string; onChanged: () => void }) {
  const d = useAws<{ status: string; input?: string; output?: string; error?: string; cause?: string; startDate?: string; stopDate?: string }>('stepfunctions', 'describeExecution', { executionArn: arn });
  const h = useAws<HistEvent[]>('stepfunctions', 'history', { executionArn: arn });
  const [confirm, setConfirm] = useState(false);
  const m = useMutation();
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-100 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-grotesk text-base font-medium text-neutral-900">Execution</span>
          <StatusPill status={d.data?.status} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => { void d.reload(); void h.reload(); }}>Refresh</Button>
          {d.data?.status === 'RUNNING' ? <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuSquare /> Stop</Button> : null}
        </div>
      </div>
      {d.error ? <ErrorState error={d.error} compact /> : null}
      {d.data ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div><div className="mb-1 text-xs text-neutral-500">Input</div><JsonBlock value={d.data.input ?? ''} maxHeight={160} /></div>
          <div><div className="mb-1 text-xs text-neutral-500">{d.data.error ? 'Error' : 'Output'}</div><JsonBlock value={d.data.error ? `${d.data.error}: ${d.data.cause ?? ''}` : d.data.output ?? '—'} maxHeight={160} /></div>
        </div>
      ) : null}
      <Section title="Event history">
        {h.error ? <ErrorState error={h.error} compact what="GetExecutionHistory" /> : (
          <ol className="relative ml-2 border-l border-neutral-100">
            {(h.data ?? []).map((e) => {
              const detailKey = Object.keys(e).find((k) => k.endsWith('EventDetails'));
              const failed = /Failed|Aborted|TimedOut/.test(e.type);
              return (
                <li key={e.id} className="mb-2 ml-4">
                  <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${failed ? 'bg-gw-red-500' : /Succeeded|Exited/.test(e.type) ? 'bg-gw-green-500' : 'bg-primary-300'}`} />
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-neutral-400">#{e.id}</span>
                    <span className="font-medium text-neutral-900">{e.type}</span>
                    {detailKey && (e[detailKey] as { name?: string })?.name ? <Pill tone="gray">{(e[detailKey] as { name?: string }).name}</Pill> : null}
                    <span className="text-xs text-neutral-500">{e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</span>
                  </div>
                </li>
              );
            })}
            {h.data && !h.data.length ? <li className="ml-4 text-sm text-neutral-400">No events.</li> : null}
          </ol>
        )}
      </Section>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Stop execution?" confirmLabel="Stop" busy={m.busy} onConfirm={async () => { if (await m.run('stepfunctions', 'stop', { executionArn: arn }, 'Execution stopped')) { setConfirm(false); void d.reload(); onChanged(); } }} />
    </div>
  );
}

function CreateMachine({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('STANDARD');
  const region = useStatus(null).status?.region ?? 'us-east-1';
  const [template, setTemplate] = useState('hello');
  const [definition, setDefinition] = useState(() => tpl('hello', 'us-east-1'));
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} wide title="Create state machine" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('stepfunctions', 'create', { name, type, definition }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)} options={['STANDARD', 'EXPRESS']} /></Field>
      </div>
      <Field label="Start from a template">
        <Select value={template} onChange={(e) => { setTemplate(e.target.value); setDefinition(tpl(e.target.value, region)); }} options={Object.entries(TEMPLATES).map(([value, t]) => ({ value, label: t.label }))} aria-label="Template" />
      </Field>
      <Field label="Definition (Amazon States Language)"><Textarea value={definition} onChange={(e) => setDefinition(e.target.value)} rows={12} /></Field>
      <InlineError error={m.error} />
    </Modal>
  );
}

function EditMachine({ arn, initial, onClose, onSaved }: { arn: string; initial: string; onClose: () => void; onSaved: () => void }) {
  const [definition, setDefinition] = useState(() => {
    try { return JSON.stringify(JSON.parse(initial), null, 2); } catch { return initial; }
  });
  const m = useMutation();
  return (
    <Modal open onClose={onClose} wide title="Edit definition" description="Saves with UpdateStateMachine. New executions use the new definition."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.busy} onClick={async () => { if (await m.run('stepfunctions', 'update', { arn, definition }, 'State machine updated')) onSaved(); }}>Save</Button></>}>
      <Field label="Definition (Amazon States Language)"><Textarea value={definition} onChange={(e) => setDefinition(e.target.value)} rows={16} aria-label="Definition" /></Field>
      <InlineError error={m.error} />
    </Modal>
  );
}
