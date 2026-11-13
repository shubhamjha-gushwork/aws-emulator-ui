'use client';

import { Pill } from './ui';
import { orderStates } from '@/lib/asl';

/** A readable step list of an Amazon States Language definition (nested for Parallel and Map). */
type State = {
  Type?: string; Next?: string; End?: boolean; Default?: string; Resource?: string; Seconds?: number; Timestamp?: string; SecondsPath?: string;
  Choices?: { Next?: string; Variable?: string; [k: string]: unknown }[]; Branches?: Machine[]; Iterator?: Machine; ItemProcessor?: Machine; ItemsPath?: string;
  Retry?: { ErrorEquals?: string[]; MaxAttempts?: number }[]; Catch?: { ErrorEquals?: string[]; Next?: string }[]; Error?: string; Cause?: string;
  Parameters?: { FunctionName?: string; [k: string]: unknown }; Arguments?: { FunctionName?: string; [k: string]: unknown }; Comment?: string;
};
type Machine = { StartAt?: string; States?: Record<string, State>; Comment?: string };

const tone = (t?: string) =>
  t === 'Task' ? 'blue' : t === 'Choice' ? 'yellow' : t === 'Fail' ? 'red' : t === 'Succeed' ? 'green' : t === 'Parallel' || t === 'Map' ? 'orange' : 'gray';

function shortResource(s: State) {
  const r = s.Resource;
  if (!r) return null;
  const fn = s.Parameters?.FunctionName ?? s.Arguments?.FunctionName;
  if (r.startsWith('arn:aws:states:::')) return `${r.slice('arn:aws:states:::'.length)}${fn ? ` → ${String(fn).split(':').pop()}` : ''}`;
  if (r.includes(':function:')) return `λ ${r.split(':function:')[1]}`;
  return r;
}

function Steps({ m, depth = 0 }: { m: Machine; depth?: number }) {
  const states = m.States ?? {};
  return (
    <ol className={depth ? 'ml-3 mt-2 border-l border-dashed border-neutral-200 pl-3' : ''}>
      {orderStates(m).map((name, i) => {
        const s = states[name];
        const res = shortResource(s);
        const nexts = [
          s.Next ? `→ ${s.Next}` : null,
          ...(s.Choices ?? []).map((c) => `when … → ${c.Next}`),
          s.Default ? `default → ${s.Default}` : null,
          s.End ? 'End' : null,
        ].filter(Boolean);
        return (
          <li key={name} className="mb-2 rounded-lg border border-neutral-100 bg-white px-3 py-2" data-testid="sfn-step">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs text-neutral-400">{i + 1}</span>
              <span className="font-medium text-neutral-900">{name}</span>
              <Pill tone={tone(s.Type)}>{s.Type}</Pill>
              {name === m.StartAt ? <Pill tone="green">Start</Pill> : null}
              {res ? <span className="break-all font-mono text-xs text-neutral-600">{res}</span> : null}
              {s.Type === 'Wait' ? <span className="text-xs text-neutral-500">{s.Seconds !== undefined ? `${s.Seconds}s` : s.SecondsPath ?? s.Timestamp}</span> : null}
              {s.Type === 'Map' && s.ItemsPath ? <span className="font-mono text-xs text-neutral-500">items {s.ItemsPath}</span> : null}
              {s.Type === 'Fail' ? <span className="text-xs text-gw-red-700">{s.Error}{s.Cause ? `: ${s.Cause}` : ''}</span> : null}
            </div>
            {nexts.length || s.Retry?.length || s.Catch?.length ? (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
                {nexts.map((n) => <span key={n}>{n}</span>)}
                {s.Retry?.map((r, k) => <span key={`r${k}`}>retry {(r.ErrorEquals ?? []).join(', ')} ×{r.MaxAttempts ?? 3}</span>)}
                {s.Catch?.map((c, k) => <span key={`c${k}`} className="text-gw-orange-700">catch {(c.ErrorEquals ?? []).join(', ')} → {c.Next}</span>)}
              </div>
            ) : null}
            {s.Branches?.map((b, k) => (
              <div key={k} className="mt-1">
                <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Branch {k + 1}</div>
                <Steps m={b} depth={depth + 1} />
              </div>
            ))}
            {s.ItemProcessor || s.Iterator ? (
              <div className="mt-1">
                <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">For each item</div>
                <Steps m={(s.ItemProcessor ?? s.Iterator)!} depth={depth + 1} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function StateGraph({ definition }: { definition: string }) {
  let m: Machine;
  try {
    m = JSON.parse(definition) as Machine;
  } catch {
    return <p className="text-sm text-gw-red-700">Definition isn&apos;t valid JSON.</p>;
  }
  if (!m.States) return <p className="text-sm text-neutral-500">No states.</p>;
  return (
    <div className="rounded-lg bg-neutral-25 p-3">
      {m.Comment ? <p className="mb-2 text-xs text-neutral-500">{m.Comment}</p> : null}
      <Steps m={m} />
    </div>
  );
}
