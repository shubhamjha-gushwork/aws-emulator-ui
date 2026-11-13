'use client';

import { useEffect, useMemo, useState, type Ref } from 'react';
import { LuChevronRight } from 'react-icons/lu';
import { Button, CopyButton, Mono, TimeAgo } from '@/components/ui';
import { logEventKey, logMessageCopyText, parseLogMessage } from '@/lib/log-event';

export interface LogEvent {
  timestamp?: number;
  message?: string;
  logStreamName?: string;
  eventId?: string;
  ingestionTime?: number;
}

export function formatLogTs(ms: number) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour12: false });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function LogEventList({
  events,
  hideStreamInRow,
  listRef,
}: {
  events: LogEvent[];
  hideStreamInRow?: boolean;
  listRef?: Ref<HTMLDivElement>;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [expandIncoming, setExpandIncoming] = useState(false);

  const keys = useMemo(() => events.map((e, i) => logEventKey(e, i)), [events]);

  // New events arriving in Follow inherit Expand all until the user collapses one or uses Collapse all.
  useEffect(() => {
    if (!expandIncoming) return;
    setOpen((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const k of keys) {
        if (!next.has(k)) {
          next.add(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [keys, expandIncoming]);

  const expandAll = () => {
    setOpen(new Set(keys));
    setExpandIncoming(true);
  };
  const collapseAll = () => {
    setOpen(new Set());
    setExpandIncoming(false);
  };
  const toggle = (key: string) => {
    setExpandIncoming(false);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      <div className="mb-2 flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" data-testid="log-expand-all" onClick={expandAll}>
          Expand all
        </Button>
        <Button type="button" size="sm" variant="ghost" data-testid="log-collapse-all" onClick={collapseAll}>
          Collapse all
        </Button>
      </div>
      <div
        ref={listRef}
        className="max-h-[520px] overflow-auto rounded-lg border border-neutral-100 bg-neutral-25 font-mono text-[12.5px]"
        data-testid="log-events"
      >
        {events.map((e, i) => (
          <LogEventRow
            key={keys[i]}
            ev={e}
            eventKey={keys[i]}
            expanded={open.has(keys[i])}
            hideStreamInRow={hideStreamInRow}
            onToggle={() => toggle(keys[i])}
          />
        ))}
      </div>
    </div>
  );
}

function LogEventRow({
  ev,
  eventKey,
  expanded,
  hideStreamInRow,
  onToggle,
}: {
  ev: LogEvent;
  eventKey: string;
  expanded: boolean;
  hideStreamInRow?: boolean;
  onToggle: () => void;
}) {
  const parsed = useMemo(() => parseLogMessage(ev.message), [ev.message]);
  const copy = logMessageCopyText(parsed);
  const iso = ev.timestamp ? new Date(ev.timestamp).toISOString() : undefined;
  const ingestedIso = ev.ingestionTime ? new Date(ev.ingestionTime).toISOString() : undefined;

  return (
    <div className="border-b border-neutral-100 last:border-0" data-testid="log-event" data-event-key={eventKey} data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-start gap-2.5 px-3 py-1.5 text-left hover:bg-white/80 focus-visible:bg-white/80 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <LuChevronRight
          className={`mt-0.5 size-3.5 shrink-0 text-neutral-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span className="w-[7.5rem] shrink-0 text-neutral-500" title={iso}>
          {ev.timestamp ? formatLogTs(ev.timestamp) : ''}
        </span>
        {!hideStreamInRow && ev.logStreamName ? (
          <span className="max-w-40 shrink-0 truncate text-primary-500" title={ev.logStreamName}>
            {ev.logStreamName}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-neutral-800">{parsed.preview || ' '}</span>
      </button>
      {expanded ? (
        <div className="border-t border-neutral-100 bg-white px-3 pt-2 pb-3 pl-10" data-testid="log-event-detail">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-sans text-neutral-500">
              {ev.logStreamName ? (
                <span className="min-w-0 truncate" title={ev.logStreamName}>
                  Stream <Mono className="text-neutral-700">{ev.logStreamName}</Mono>
                </span>
              ) : null}
              {ev.ingestionTime ? (
                <span title={ingestedIso}>
                  Ingested <TimeAgo value={ev.ingestionTime} />
                </span>
              ) : null}
            </div>
            <CopyButton text={copy} label="Copy" />
          </div>
          {parsed.prefix ? <div className="mb-1.5 text-[11px] text-neutral-500">{parsed.prefix}</div> : null}
          {parsed.json ? (
            <pre className="overflow-auto rounded-lg border border-neutral-100 bg-neutral-25 px-3 py-2 leading-relaxed whitespace-pre-wrap text-neutral-800">
              {parsed.json}
            </pre>
          ) : (
            <pre className="overflow-auto leading-relaxed whitespace-pre-wrap break-all text-neutral-800">{parsed.text}</pre>
          )}
        </div>
      ) : null}
    </div>
  );
}
