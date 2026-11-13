'use client';

import { useCallback, useEffect, useState } from 'react';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import { ListCard } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, ConfirmDialog, Field, Input, KV, Modal, Mono, Pill, Select, Spinner, StatusPill, Textarea, formatBytes } from '@/components/ui';
import { callAws, toApiError, useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';
import type { ApiError } from '@/lib/errors';

interface Table {
  TableName: string; TableArn?: string; TableStatus?: string; ItemCount?: number; TableSizeBytes?: number;
  KeySchema?: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[]; AttributeDefinitions?: { AttributeName: string; AttributeType: string }[];
  BillingModeSummary?: { BillingMode?: string }; GlobalSecondaryIndexes?: { IndexName: string }[];
}
type Item = Record<string, unknown>;

const keysOf = (t: Table) => ({ pk: t.KeySchema?.find((k) => k.KeyType === 'HASH')?.AttributeName, sk: t.KeySchema?.find((k) => k.KeyType === 'RANGE')?.AttributeName });
const show = (v: unknown) => (v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function DynamoPage() {
  const list = useAws<Table[]>('dynamodb', 'list');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = list.data?.find((t) => t.TableName === sel) ?? null;
  return (
    <>
      <PageHeader serviceId="dynamodb" actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create table</Button>} />
      <div className="flex flex-col gap-6">
        <ListCard title="Tables" subtitle={list.data ? `${list.data.length} total` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListTables">
          <DataTable
            rows={list.data ?? []}
            rowKey={(t) => t.TableName}
            selectedKey={sel}
            onRowClick={(t) => setSel(t.TableName)}
            empty="No tables yet."
            columns={[
              { key: 'n', header: 'Name', cell: (t) => <span className="font-medium text-neutral-900">{t.TableName}</span> },
              { key: 's', header: 'Status', cell: (t) => <StatusPill status={t.TableStatus} /> },
              { key: 'k', header: 'Keys', cell: (t) => { const k = keysOf(t); return <span className="flex gap-1"><Pill tone="blue">PK {k.pk}</Pill>{k.sk ? <Pill tone="gray">SK {k.sk}</Pill> : null}</span>; } },
              { key: 'c', header: 'Items', align: 'right', cell: (t) => t.ItemCount ?? '—' },
              { key: 'z', header: 'Size', align: 'right', cell: (t) => formatBytes(t.TableSizeBytes) },
            ]}
          />
        </ListCard>
        {selected ? <TableDetail key={selected.TableName} t={selected} onChanged={list.reload} onDeleted={() => { setSel(null); void list.reload(); }} /> : null}
      </div>
      <CreateTable open={creating} onClose={() => setCreating(false)} onCreated={(n) => { setCreating(false); setSel(n); setTimeout(() => void list.reload(), 400); }} />
    </>
  );
}

function TableDetail({ t, onChanged, onDeleted }: { t: Table; onChanged: () => void; onDeleted: () => void }) {
  const { pk, sk } = keysOf(t);
  const [items, setItems] = useState<Item[] | null>(null);
  const [lastKey, setLastKey] = useState<string | undefined>(undefined);
  const [err, setErr] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [putting, setPutting] = useState(false);
  const [confirm, setConfirm] = useState<Item | 'table' | null>(null);
  const m = useMutation();

  const scan = useCallback(async (start?: string) => {
    setLoading(true);
    try {
      const r = await callAws<{ items: Item[]; lastKey?: string }>('dynamodb', 'scan', { name: t.TableName, limit: 50, startKey: start });
      setItems((prev) => (start ? [...(prev ?? []), ...r.items] : r.items));
      setLastKey(r.lastKey);
      setErr(null);
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setLoading(false);
    }
  }, [t.TableName]);
  useEffect(() => { void scan(); }, [scan]);

  const cols = Array.from(new Set([pk, sk, ...(items ?? []).flatMap((i) => Object.keys(i))].filter(Boolean) as string[])).slice(0, 8);
  const keyOf = (i: Item) => JSON.stringify(sk ? { [pk!]: i[pk!], [sk]: i[sk] } : { [pk!]: i[pk!] });

  return (
    <ListCard
      title={t.TableName}
      subtitle={<Mono className="text-neutral-500">{t.TableArn}</Mono>}
      onReload={() => scan()}
      loading={loading}
      actions={
        <>
          <Button size="sm" variant="primary" onClick={() => setPutting(true)}><LuPlus /> Put item</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm('table')}><LuTrash2 /> Delete table</Button>
        </>
      }
    >
      <div className="border-b border-neutral-100 px-5 py-4">
        <KV items={[['Partition key', `${pk} (${t.AttributeDefinitions?.find((a) => a.AttributeName === pk)?.AttributeType})`], ['Sort key', sk ? `${sk} (${t.AttributeDefinitions?.find((a) => a.AttributeName === sk)?.AttributeType})` : '—'], ['Billing', t.BillingModeSummary?.BillingMode ?? 'PROVISIONED'], ['Indexes', t.GlobalSecondaryIndexes?.map((g) => g.IndexName).join(', ') || '—']]} />
      </div>
      {err ? <ErrorState error={err} what="Scan" /> : items === null ? <Spinner /> : (
        <>
          <DataTable
            rows={items}
            rowKey={keyOf}
            empty="Table is empty. Put an item to get started."
            columns={[
              ...cols.map((c) => ({ key: c, header: <span className={c === pk || c === sk ? 'text-primary-500' : ''}>{c}</span>, cell: (i: Item) => <span className="block max-w-xs truncate font-mono text-[12.5px]" title={show(i[c])}>{show(i[c])}</span> })),
              { key: 'x', header: '', align: 'right' as const, cell: (i: Item) => <Button size="icon" variant="ghost" aria-label="Delete item" onClick={() => setConfirm(i)}><LuTrash2 /></Button> },
            ]}
          />
          <div className="flex items-center justify-between border-t border-neutral-100 px-5 py-2 text-xs text-neutral-500">
            <span>{items.length} items scanned{cols.length === 8 ? ' · showing first 8 attributes' : ''}</span>
            {lastKey ? <Button size="sm" variant="ghost" loading={loading} onClick={() => scan(lastKey)}>Load more</Button> : null}
          </div>
        </>
      )}
      <PutItem open={putting} t={t} onClose={() => setPutting(false)} onDone={() => { setPutting(false); void scan(); onChanged(); }} />
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'table' ? `Delete table ${t.TableName}?` : 'Delete item?'}
        description={confirm === 'table' ? 'The table and all its items are deleted.' : confirm ? keyOf(confirm) : undefined}
        typeToConfirm={confirm === 'table' ? t.TableName : undefined}
        busy={m.busy}
        onConfirm={async () => {
          if (confirm === 'table') {
            if (await m.run('dynamodb', 'delete', { name: t.TableName }, `Deleted ${t.TableName}`)) { setConfirm(null); onDeleted(); }
          } else if (confirm && (await m.run('dynamodb', 'deleteItem', { name: t.TableName, key: keyOf(confirm) }, 'Item deleted'))) {
            setConfirm(null);
            void scan();
            onChanged();
          }
        }}
      />
    </ListCard>
  );
}

function PutItem({ open, t, onClose, onDone }: { open: boolean; t: Table; onClose: () => void; onDone: () => void }) {
  const { pk, sk } = keysOf(t);
  const [item, setItem] = useState('');
  useEffect(() => {
    if (open) setItem(JSON.stringify({ [pk ?? 'id']: 'new-id', ...(sk ? { [sk]: 'sort-value' } : {}), name: 'example' }, null, 2));
  }, [open, pk, sk]);
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title={`Put item into ${t.TableName}`} description="Plain JSON — it's converted to DynamoDB attribute values. An item with the same key is replaced." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.busy} onClick={async () => (await m.run('dynamodb', 'putItem', { name: t.TableName, item }, 'Item saved')) && onDone()}>Save</Button></>}>
      <Textarea value={item} onChange={(e) => setItem(e.target.value)} rows={10} aria-label="Item JSON" />
      <InlineError error={m.error} />
    </Modal>
  );
}

function CreateTable({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (n: string) => void }) {
  const [name, setName] = useState('');
  const [pk, setPk] = useState('id');
  const [pkType, setPkType] = useState('S');
  const [sk, setSk] = useState('');
  const [skType, setSkType] = useState('S');
  const m = useMutation();
  const types = [{ value: 'S', label: 'String' }, { value: 'N', label: 'Number' }, { value: 'B', label: 'Binary' }];
  return (
    <Modal open={open} onClose={onClose} title="Create table" description="On-demand (PAY_PER_REQUEST) billing." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || !pk} loading={m.busy} onClick={async () => (await m.run('dynamodb', 'create', { name, pk, pkType, sk, skType }, `Created ${name}`)) && onCreated(name)}>Create</Button></>}>
      <Field label="Table name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <Field label="Partition key"><Input value={pk} onChange={(e) => setPk(e.target.value)} /></Field>
        <Field label="Type"><Select value={pkType} onChange={(e) => setPkType(e.target.value)} options={types} /></Field>
        <Field label="Sort key (optional)"><Input value={sk} onChange={(e) => setSk(e.target.value)} /></Field>
        <Field label="Type"><Select value={skType} onChange={(e) => setSkType(e.target.value)} options={types} /></Field>
      </div>
      <InlineError error={m.error} />
    </Modal>
  );
}
