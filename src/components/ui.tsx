'use client';

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { LuCheck, LuCopy, LuEye, LuEyeOff, LuLoaderCircle, LuX } from 'react-icons/lu';
import { cn } from '@/lib/cn';

// ---------- Button
type Variant = 'primary' | 'outline' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-600',
  outline: 'border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-25',
  danger: 'border border-gw-red-100 bg-white text-gw-red-700 hover:bg-gw-red-100',
  ghost: 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900',
};
export function Button({
  variant = 'outline', size = 'md', loading, className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'icon'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
        size === 'md' && 'h-9 px-4',
        size === 'sm' && 'h-8 gap-1.5 px-3',
        size === 'icon' && 'size-8',
        variants[variant],
        className,
      )}
    >
      {loading ? <LuLoaderCircle className="animate-spin" /> : null}
      {children}
    </button>
  );
}

// ---------- Card
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-neutral-100 bg-white shadow-s3', className)}>{children}</div>;
}
export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3">
      <div className="min-w-0">
        <div className="truncate font-grotesk text-lg font-medium text-neutral-900">{title}</div>
        {subtitle ? <div className="truncate text-[13px] text-neutral-500">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// ---------- Pills
export type Tone = 'green' | 'red' | 'orange' | 'yellow' | 'blue' | 'gray';
const tones: Record<Tone, string> = {
  green: 'bg-gw-green-100 text-gw-green-700',
  red: 'bg-gw-red-100 text-gw-red-700',
  orange: 'bg-gw-orange-100 text-gw-orange-700',
  yellow: 'bg-gw-yellow-100 text-gw-yellow-700',
  blue: 'bg-gw-blue-100 text-gw-blue-700',
  gray: 'bg-neutral-50 text-neutral-600',
};
const dots: Record<Tone, string> = {
  green: 'bg-gw-green-500', red: 'bg-gw-red-500', orange: 'bg-gw-orange-500', yellow: 'bg-gw-yellow-500', blue: 'bg-gw-blue-500', gray: 'bg-neutral-400',
};
export function Pill({ tone = 'gray', dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone], className)}>
      {dot ? <span className={cn('h-1.5 w-1.5 rounded-full', dots[tone])} /> : null}
      {children}
    </span>
  );
}

/** Maps common AWS status strings to a semantic tone. */
export function statusTone(status?: string | null): Tone {
  const s = (status ?? '').toUpperCase();
  if (/^(ACTIVE|ENABLED|SUCCEEDED|RUNNING|AVAILABLE|HEALTHY|IN_SYNC|OK|COMPLETED|CREATE_COMPLETE|PRIMARY|DEPLOYED)$/.test(s)) return 'green';
  if (/(FAILED|ERROR|UNHEALTHY|ABORTED|TIMED_OUT|STOPPED|DELETED|INACTIVE)/.test(s)) return 'red';
  if (/(PENDING|PROVISIONING|CREATING|UPDATING|IN_PROGRESS|STARTING|ACTIVATING|INITIAL|DRAINING)/.test(s)) return 'yellow';
  if (/(DISABLED|DELETING|DEPROVISIONING|UNUSED|UNAVAILABLE)/.test(s)) return 'orange';
  return 'blue';
}
export function StatusPill({ status }: { status?: string | null }) {
  if (!status) return <span className="text-neutral-400">—</span>;
  return <Pill tone={statusTone(status)} dot>{status}</Pill>;
}

// ---------- Form fields
const inputCls =
  'h-9 w-full min-w-0 rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm text-neutral-900 transition-[color,box-shadow] outline-none placeholder:text-neutral-400 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputCls, props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(inputCls, 'h-auto min-h-24 py-2 font-mono text-[13px] leading-relaxed', props.className)} />;
}
export function Select({ options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: (string | { value: string; label: string })[] }) {
  return (
    <select {...props} className={cn(inputCls, 'cursor-pointer pr-8', props.className)}>
      {options.map((o) => {
        const v = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        );
      })}
    </select>
  );
}
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-neutral-800">{label}</span>
      {children}
      {hint ? <span className="text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}
export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-800">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" />
      {label}
    </label>
  );
}

// ---------- Segmented control
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="inline-flex items-center gap-1 rounded-lg bg-neutral-50 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          data-state={value === o.value ? 'active' : 'inactive'}
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className="cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium text-neutral-500 transition-colors hover:text-neutral-900 data-[state=active]:bg-white data-[state=active]:text-neutral-900 data-[state=active]:shadow-sm"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Modal / confirm
export function Modal({ open, onClose, title, description, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/30 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={cn('gw-pop w-full rounded-xl border border-neutral-100 bg-white shadow-s4', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="font-grotesk text-lg font-semibold text-neutral-900">{title}</h2>
            {description ? <p className="mt-1 text-sm text-neutral-500">{description}</p> : null}
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <LuX />
          </Button>
        </div>
        {hasContent(children) ? <div className="flex flex-col gap-4 px-6 py-5">{children}</div> : <div className="h-5" />}
        {footer ? <div className="flex flex-col-reverse gap-2 rounded-b-xl border-t border-neutral-100 bg-neutral-25 px-6 py-3 sm:flex-row sm:justify-end">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Delete', typeToConfirm, busy, children }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; description?: ReactNode; confirmLabel?: string; typeToConfirm?: string; busy?: boolean; children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const ok = !typeToConfirm || typed === typeToConfirm;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" className="bg-destructive hover:bg-destructive/90" disabled={!ok} loading={busy} onClick={onConfirm} data-testid="confirm-button">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {typeToConfirm ? (
        <Field label={`Type "${typeToConfirm}" to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      ) : null}
    </Modal>
  );
}

function hasContent(c: ReactNode): boolean {
  if (Array.isArray(c)) return c.some(hasContent);
  return c !== null && c !== undefined && c !== false && c !== '';
}

// ---------- Misc
export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-10 text-center text-sm text-neutral-400">{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-neutral-500">
      <LuLoaderCircle className="h-4 w-4 animate-spin text-primary" /> {label}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex cursor-pointer items-center gap-1 rounded p-0.5 text-neutral-400 hover:text-neutral-700"
    >
      {done ? <LuCheck className="h-3.5 w-3.5 text-gw-green-700" /> : <LuCopy className="h-3.5 w-3.5" />}
      {label ? <span className="text-xs">{label}</span> : null}
    </button>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[12.5px] text-neutral-700', className)}>{children}</span>;
}

export function JsonBlock({ value, className, maxHeight = 420 }: { value: unknown; className?: string; maxHeight?: number }) {
  const text = typeof value === 'string' ? prettyMaybe(value) : JSON.stringify(value, null, 2);
  return (
    <div className={cn('relative rounded-lg border border-neutral-100 bg-neutral-25', className)}>
      <div className="absolute right-2 top-2">
        <CopyButton text={text} />
      </div>
      <pre className="overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-neutral-800" style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  );
}

export function prettyMaybe(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">{k}</dt>
          <dd className="mt-0.5 break-all text-sm text-neutral-900">{v ?? <span className="text-neutral-400">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Masked({ value, onReveal }: { value?: string; onReveal?: () => Promise<string | undefined> }) {
  const [shown, setShown] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-neutral-100 bg-neutral-25 px-3 py-2 font-mono text-[12.5px] text-neutral-800">
        {shown !== undefined ? prettyMaybe(shown) : '••••••••••••••••'}
      </pre>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          if (shown !== undefined) return setShown(undefined);
          setBusy(true);
          try {
            setShown(value ?? (await onReveal?.()) ?? '');
          } finally {
            setBusy(false);
          }
        }}
      >
        {shown !== undefined ? <LuEyeOff /> : <LuEye />} {shown !== undefined ? 'Hide' : 'Reveal'}
      </Button>
    </div>
  );
}

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  useEffect(() => {
    saved.current = fn;
  }, [fn]);
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function formatBytes(n?: number | null) {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export function TimeAgo({ value }: { value?: string | number | Date | null }) {
  const [text, setText] = useState('…');
  useEffect(() => {
    if (value === undefined || value === null || value === '') return setText('—');
    const d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    if (Number.isNaN(d.getTime())) return setText(String(value));
    setText(d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  }, [value]);
  return <span suppressHydrationWarning>{text}</span>;
}
