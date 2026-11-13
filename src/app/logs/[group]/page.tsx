'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuPause, LuPlay, LuSearch, LuSend, LuTrash2, LuX } from 'react-icons/lu';
import { ListCard } from '@/components/ListCard';
import { LogEventList } from '@/components/LogEvents';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { Button, ConfirmDialog, Input, Mono, Pill, Segmented, Select, TimeAgo, useInterval } from '@/components/ui';
import { callAws, toApiError, useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';
import type { ApiError } from '@/lib/errors';
import { isUiCapturedStream, logSource } from '@/lib/log-sources';

interface Stream { logStreamName: string; lastEventTimestamp?: number; creationTime?: number }
interface Ev { timestamp?: number; message?: string; logStreamName?: string; eventId?: string; ingestionTime?: number }

function decodeGroup(raw: string | string[] | undefined) {
  const v = Array.isArray(raw) ? raw.join('/') : raw ?? '';
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export default function LogGroupPage() {
  const params = useParams<{ group: string }>();
  const group = decodeGroup(params.group);
  const router = useRouter();
  const ecsGroups = useAws<string[]>('logs', 'ecsGroups');
  const source = logSource(group, ecsGroups.data ?? []);
  return (
    <>
      <PageHeader
        serviceId="logs"
        title={group}
        subtitle={`${source === 'lambda' ? 'Lambda' : source === 'ecs' ? 'ECS' : 'Other'} log group`}
        detail={{ name: group, href: '/logs' }}
      />
      <GroupDetail key={group} group={group} onDeleted={() => router.push('/logs')} />
    </>
  );
}

const RANGES = [
  { value: '15m', label: '15m', ms: 15 * 60_000 },
  { value: '1h', label: '1h', ms: 3_600_000 },
  { value: '24h', label: '24h', ms: 86_400_000 },
  { value: 'all', label: 'All', ms: 0 },
] as const;
type Range = (typeof RANGES)[number]['value'];
interface QueryResult { events: Ev[]; total: number; truncated: boolean }

/** One view per log group: filter, stream, time range and follow in a toolbar, events filtered in place below. */
function GroupDetail({ group, onDeleted }: { group: string; onDeleted: () => void }) {
  const streams = useAws<Stream[]>('logs', 'streams', { group });
  const [input, setInput] = useState('');
  const [pattern, setPattern] = useState('');
  const [stream, setStream] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [follow, setFollow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [rev, setRev] = useState(0);
  const m = useMutation();

  // Debounce typing; Enter applies at once.
  useEffect(() => {
    const t = setTimeout(() => setPattern(input.trim()), 400);
    return () => clearTimeout(t);
  }, [input]);

  // Evaluated when the query changes (not on every render), so the window stays put while following.
  const startTime = useMemo(() => {
    const ms = RANGES.find((r) => r.value === range)!.ms;
    return ms ? Date.now() - ms : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, rev]);
  const params = { group, pattern, stream: stream || undefined, startTime, limit: 500 };
  const q = useAws<QueryResult>('logs', 'query', params);
  const [extra, setExtra] = useState<Ev[]>([]);
  const [err, setErr] = useState<ApiError | null>(null);
  const key = JSON.stringify(params);
  useEffect(() => setExtra([]), [key]);

  // Keep showing the previous result while a new query loads, so the list doesn't jump.
  const last = useRef<QueryResult | undefined>(undefined);
  if (q.data) last.current = q.data;
  const base = q.data ?? last.current;
  const events = useMemo(() => {
    const seen = new Set<string>();
    return [...(base?.events ?? []), ...extra].filter((e) => {
      const id = e.eventId ?? `${e.timestamp}|${e.logStreamName}|${e.message}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [base, extra]);

  useInterval(async () => {
    const since = events.at(-1)?.timestamp ?? startTime ?? Date.now() - 60_000;
    try {
      const r = await callAws<QueryResult>('logs', 'query', { ...params, startTime: since, limit: 500 });
      if (r.events.length) setExtra((x) => [...x, ...r.events].slice(-2000));
      setErr(null);
      void streams.reload();
    } catch (e) {
      setErr(toApiError(e));
      setFollow(false);
    }
  }, follow ? 2000 : null);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [events.length, follow]);

  const filtered = !!pattern || !!stream || range !== 'all';
  const clearAll = () => { setInput(''); setPattern(''); setStream(''); setRange('all'); };
  const streamOptions = [
    { value: '', label: `All streams${streams.data ? ` (${streams.data.length})` : ''}` },
    ...(streams.data ?? []).map((s) => ({ value: s.logStreamName, label: isUiCapturedStream(s.logStreamName) ? `${s.logStreamName} · captured by UI` : s.logStreamName })),
  ];

  return (
    <ListCard
      className="overflow-visible"
      title="Log events"
      subtitle={streams.data ? `${streams.data.length} stream${streams.data.length === 1 ? '' : 's'}` : undefined}
      actions={
        <>
          <TestEvent group={group} onWritten={() => { void streams.reload(); setRev((r) => r + 1); void q.reload(); }} />
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>
        </>
      }
    >
      {streams.error ? <ErrorState error={streams.error} what="DescribeLogStreams" /> : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-5 py-3" data-testid="log-toolbar">
            <div className="relative min-w-56 flex-1">
              <LuSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-400" />
              <Input
                aria-label="Filter pattern"
                data-testid="log-filter"
                className="h-8 pr-8 pl-9"
                placeholder='Filter events: ERROR, "exact phrase", { $.level = "error" }'
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setPattern(input.trim());
                  if (e.key === 'Escape') { setInput(''); setPattern(''); }
                }}
              />
              {input ? (
                <button type="button" aria-label="Clear filter" onClick={() => { setInput(''); setPattern(''); }} className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700">
                  <LuX className="size-3.5" />
                </button>
              ) : null}
            </div>
            <Select aria-label="Log stream" data-testid="log-stream" className="h-8 w-56 text-[13px]" value={stream} onChange={(e) => setStream(e.target.value)} options={streamOptions} />
            <Segmented value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
            <Button size="sm" variant={follow ? 'primary' : 'outline'} data-testid="log-follow" onClick={() => setFollow(!follow)}>
              {follow ? <LuPause /> : <LuPlay />} {follow ? 'Following' : 'Follow'}
            </Button>
          </div>
          <div className="flex items-center gap-2 px-5 pt-3 text-xs text-neutral-500">
            {q.loading && !base ? <span>Loading…</span> : (
              <>
                <span data-testid="log-count">
                  {events.length} event{events.length === 1 ? '' : 's'}
                  {base?.truncated ? ' (newest shown)' : ''}
                  {pattern ? <> matching <Mono className="text-neutral-700">{pattern}</Mono></> : null}
                </span>
                {events.length ? <span>· last <TimeAgo value={events.at(-1)?.timestamp} /></span> : null}
                {q.loading ? <span className="text-neutral-400">· updating…</span> : null}
                {follow ? <Pill tone="green" dot>live · 2s</Pill> : null}
              </>
            )}
          </div>
          <div className="px-5 pt-2 pb-5">
            {q.error ? <ErrorState error={q.error} compact what="FilterLogEvents" /> : err ? <InlineError error={err} /> : null}
            {!q.error && base ? (
              events.length ? (
                <LogEventList events={events} hideStreamInRow={!!stream} listRef={listRef} />
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-neutral-200 px-4 py-3 text-sm text-neutral-500" data-testid="log-empty">
                  <span>
                    {streams.data && !streams.data.length
                      ? 'No events yet. This group has no streams.'
                      : filtered
                        ? 'No events match these filters.'
                        : 'No events in this group.'}
                    {follow ? ' Waiting for new events…' : ''}
                  </span>
                  {filtered ? <Button size="sm" variant="ghost" onClick={clearAll}>Clear filters</Button> : null}
                </div>
              )
            ) : null}
          </div>
        </>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${group}?`} description="All streams and events in the group are deleted." busy={m.busy} onConfirm={async () => { if (await m.run('logs', 'deleteGroup', { name: group }, `Deleted ${group}`)) { setConfirm(false); onDeleted(); } }} />
    </ListCard>
  );
}

/** Small popover for writing a test event (stream aws-emulator-ui). */
function TestEvent({ group, onWritten }: { group: string; onWritten: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const m = useMutation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const put = async () => {
    if (msg && (await m.run('logs', 'putEvent', { group, message: msg }, 'Event written'))) { setMsg(''); setOpen(false); onWritten(); }
  };
  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="outline" data-testid="test-event" onClick={() => setOpen(!open)}><LuSend /> Test event</Button>
      {open ? (
        <div className="absolute top-full right-0 z-30 mt-2 flex w-80 flex-col gap-2 rounded-xl border border-neutral-100 bg-white p-3 shadow-s4" data-testid="test-event-popover">
          <span className="text-xs text-neutral-500">Writes one event to stream <Mono>aws-emulator-ui</Mono>.</span>
          <div className="flex gap-2">
            <Input autoFocus className="h-8" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void put(); }} placeholder="hello from the UI" />
            <Button size="sm" variant="primary" disabled={!msg} loading={m.busy} onClick={put}>Put</Button>
          </div>
          <InlineError error={m.error} />
        </div>
      ) : null}
    </div>
  );
}

