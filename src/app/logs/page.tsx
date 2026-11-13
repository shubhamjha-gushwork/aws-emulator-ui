'use client';

import { useState } from 'react';
import { LuPause, LuPlay, LuPlus, LuSearch, LuSend, LuTrash2 } from 'react-icons/lu';
import { ListCard } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, ConfirmDialog, Empty, Field, Input, Modal, Pill, Segmented, TimeAgo, formatBytes, useInterval } from '@/components/ui';
import { callAws, toApiError, useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';
import type { ApiError } from '@/lib/errors';

interface Group { logGroupName: string; arn?: string; creationTime?: number; storedBytes?: number; retentionInDays?: number }
interface Stream { logStreamName: string; lastEventTimestamp?: number; creationTime?: number }
interface Ev { timestamp?: number; message?: string; logStreamName?: string; eventId?: string }

export default function LogsPage() {
  const [prefix, setPrefix] = useState('');
  const groups = useAws<Group[]>('logs', 'groups', { prefix });
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader serviceId="logs" actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create log group</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
        <ListCard
          title="Log groups"
          subtitle={groups.data ? `${groups.data.length} shown` : undefined}
          loading={groups.loading}
          error={groups.error}
          onReload={groups.reload}
          hasData={!!groups.data}
          what="DescribeLogGroups"
          actions={<Input className="h-8 w-40" placeholder="Prefix…" value={prefix} onChange={(e) => setPrefix(e.target.value)} />}
        >
          <DataTable
            rows={groups.data ?? []}
            rowKey={(g) => g.logGroupName}
            selectedKey={sel}
            onRowClick={(g) => setSel(g.logGroupName)}
            empty="No log groups."
            columns={[
              { key: 'n', header: 'Name', cell: (g) => <span className="break-all font-medium text-neutral-900">{g.logGroupName}</span> },
              { key: 's', header: 'Stored', align: 'right', cell: (g) => formatBytes(g.storedBytes) },
            ]}
          />
        </ListCard>
        {sel ? <GroupDetail key={sel} group={sel} onDeleted={() => { setSel(null); void groups.reload(); }} /> : <ListCard title="Log events"><Empty>Select a log group to tail its streams.</Empty></ListCard>}
      </div>
      <CreateGroup open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void groups.reload(); }} />
    </>
  );
}

function GroupDetail({ group, onDeleted }: { group: string; onDeleted: () => void }) {
  const streams = useAws<Stream[]>('logs', 'streams', { group });
  const [mode, setMode] = useState<'tail' | 'filter'>('tail');
  const [stream, setStream] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState('');
  const m = useMutation();
  const active = stream ?? streams.data?.[0]?.logStreamName ?? null;
  return (
    <ListCard
      title={group}
      subtitle={streams.data ? `${streams.data.length} streams` : undefined}
      actions={
        <>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'tail', label: 'Tail stream' }, { value: 'filter', label: 'Filter group' }]} />
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>
        </>
      }
    >
      {streams.error ? <ErrorState error={streams.error} what="DescribeLogStreams" /> : (
        <div className="flex flex-col gap-4 px-5 py-5">
          {mode === 'tail' ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {(streams.data ?? []).map((s) => (
                  <button key={s.logStreamName} onClick={() => setStream(s.logStreamName)} className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active === s.logStreamName ? 'border-neutral-300 bg-neutral-100 text-neutral-900' : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-700'}`}>
                    {s.logStreamName}
                  </button>
                ))}
                {streams.data && !streams.data.length ? <span className="text-sm text-neutral-400">No streams yet — write a test event below.</span> : null}
              </div>
              {active ? <Tail key={active} group={group} stream={active} /> : null}
            </>
          ) : (
            <Filter group={group} />
          )}
          <div className="flex items-end gap-2 border-t border-neutral-100 pt-4">
            <Field label="Write a test event (stream aws-emulator-ui)" className="flex-1"><Input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="hello from the UI" /></Field>
            <Button disabled={!msg} loading={m.busy} onClick={async () => { if (await m.run('logs', 'putEvent', { group, message: msg }, 'Event written')) { setMsg(''); void streams.reload(); } }}><LuSend /> Put</Button>
          </div>
        </div>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${group}?`} description="All streams and events in the group are deleted." busy={m.busy} onConfirm={async () => { if (await m.run('logs', 'deleteGroup', { name: group }, `Deleted ${group}`)) { setConfirm(false); onDeleted(); } }} />
    </ListCard>
  );
}

function EventList({ events }: { events: Ev[] }) {
  if (!events.length) return <Empty>No events.</Empty>;
  return (
    <div className="max-h-[440px] overflow-auto rounded-lg border border-neutral-100 bg-neutral-25 font-mono text-[12.5px]" data-testid="log-events">
      {events.map((e, i) => (
        <div key={e.eventId ?? i} className="flex gap-3 border-b border-neutral-100 px-3 py-1.5 last:border-0">
          <span className="shrink-0 text-neutral-500">{e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</span>
          {e.logStreamName ? <span className="shrink-0 text-primary-500">{e.logStreamName}</span> : null}
          <span className="whitespace-pre-wrap break-all text-neutral-800">{e.message}</span>
        </div>
      ))}
    </div>
  );
}

function Tail({ group, stream }: { group: string; stream: string }) {
  const first = useAws<{ events: Ev[]; nextForwardToken?: string }>('logs', 'events', { group, stream });
  const [extra, setExtra] = useState<Ev[]>([]);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const next = token ?? first.data?.nextForwardToken;
  useInterval(async () => {
    if (!next) return;
    try {
      const r = await callAws<{ events: Ev[]; nextForwardToken?: string }>('logs', 'events', { group, stream, nextToken: next });
      if (r.events.length) setExtra((x) => [...x, ...r.events]);
      setToken(r.nextForwardToken);
    } catch (e) {
      setErr(toApiError(e));
      setLive(false);
    }
  }, live ? 2000 : null);
  if (first.error) return <ErrorState error={first.error} compact what="GetLogEvents" />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant={live ? 'primary' : 'outline'} onClick={() => setLive(!live)}>{live ? <LuPause /> : <LuPlay />} {live ? 'Live (2s)' : 'Follow'}</Button>
        <span className="text-xs text-neutral-500">Last event <TimeAgo value={(extra.at(-1) ?? first.data?.events.at(-1))?.timestamp} /></span>
        {live ? <Pill tone="green" dot>tailing</Pill> : null}
      </div>
      {err ? <InlineError error={err} /> : null}
      <EventList events={[...(first.data?.events ?? []), ...extra]} />
    </div>
  );
}

function Filter({ group }: { group: string }) {
  const [pattern, setPattern] = useState('');
  const [events, setEvents] = useState<Ev[] | null>(null);
  const m = useMutation();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <Field label="Filter pattern" hint="CloudWatch Logs syntax, e.g. ERROR or { $.level = &quot;error&quot; }" className="flex-1"><Input value={pattern} onChange={(e) => setPattern(e.target.value)} /></Field>
        <Button variant="primary" loading={m.busy} onClick={async () => setEvents((await m.run<Ev[]>('logs', 'filter', { group, pattern })) ?? null)}><LuSearch /> Search</Button>
      </div>
      {m.error ? <ErrorState error={m.error} compact what="FilterLogEvents" /> : events ? <EventList events={events} /> : null}
    </div>
  );
}

function CreateGroup({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create log group" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('logs', 'createGroup', { name }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <Field label="Log group name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="/my/app" autoFocus /></Field>
      <InlineError error={m.error} />
    </Modal>
  );
}
