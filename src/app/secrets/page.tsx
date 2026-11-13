'use client';

import { useState } from 'react';
import { useSelection } from '@/components/selection';
import { LuPencil, LuPlus, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Checkbox, ConfirmDialog, Empty, Field, Input, KV, Masked, Modal, Mono, Pill, Textarea, TimeAgo } from '@/components/ui';
import { callAws, useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Secret { ARN: string; Name: string; Description?: string; LastChangedDate?: string; CreatedDate?: string; DeletedDate?: string; SecretVersionsToStages?: Record<string, string[]> }

export default function SecretsPage() {
  const list = useAws<Secret[]>('secrets', 'list');
  const [sel, setSel] = useSelection('secret');
  const [creating, setCreating] = useState(false);
  const selected = list.data?.find((s) => s.ARN === sel || s.Name === sel) ?? null;
  return (
    <>
      <PageHeader serviceId="secrets" detail={sel ? { name: selected?.Name ?? sel, onBack: () => setSel(null) } : undefined} actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create secret</Button>} />
      <div className="flex flex-col gap-6">
        {!sel ? (
        <ListCard title="Secrets" subtitle={list.data ? `${list.data.length} total · values are never listed` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListSecrets">
          <DataTable
            rows={list.data ?? []}
            rowKey={(s) => s.ARN}
            onRowClick={(s) => setSel(s.ARN)}
            empty="No secrets yet."
            columns={[
              { key: 'n', header: 'Name', cell: (s) => <span className="font-medium text-neutral-900">{s.Name}</span> },
              { key: 'd', header: 'Description', cell: (s) => <span className="text-neutral-500">{s.Description || '—'}</span> },
              { key: 's', header: 'Status', cell: (s) => (s.DeletedDate ? <Pill tone="orange" dot>Scheduled for deletion</Pill> : <Pill tone="green" dot>Active</Pill>) },
              { key: 'c', header: 'Last changed', cell: (s) => <span className="text-neutral-500"><TimeAgo value={s.LastChangedDate ?? s.CreatedDate} /></span> },
            ]}
          />
        </ListCard>
        ) : null}
        {selected ? <SecretDetail key={selected.ARN} s={selected} onChanged={list.reload} onDeleted={() => { setSel(null); void list.reload(); }} /> : sel && list.data ? <ListCard title="Secret details"><Empty>Not found in this region. It may have been deleted.</Empty></ListCard> : null}
      </div>
      <CreateSecret open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void list.reload(); }} />
    </>
  );
}

function SecretDetail({ s, onChanged, onDeleted }: { s: Secret; onChanged: () => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [force, setForce] = useState(true);
  const [rev, setRev] = useState(0);
  const m = useMutation();
  return (
    <ListCard
      title={s.Name}
      subtitle={<Mono className="text-neutral-500">{s.ARN}</Mono>}
      actions={
        <>
          <Button size="sm" onClick={() => { setValue(''); setEditing(true); }}><LuPencil /> New value</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 px-5 py-5">
        <KV items={[['Description', s.Description || '—'], ['Created', <TimeAgo key="c" value={s.CreatedDate} />], ['Versions', String(Object.keys(s.SecretVersionsToStages ?? {}).length)], ['Last changed', <TimeAgo key="l" value={s.LastChangedDate} />]]} />
        <Section title="Current value (AWSCURRENT)">
          <Masked key={rev} onReveal={async () => (await callAws<{ value: string }>('secrets', 'getValue', { id: s.ARN })).value} />
        </Section>
        <Section title="Versions">
          <div className="flex flex-col gap-1.5">
            {Object.entries(s.SecretVersionsToStages ?? {}).map(([v, stages]) => (
              <div key={v} className="flex items-center justify-between gap-2 rounded-md border border-neutral-100 px-3 py-1.5">
                <Mono className="truncate">{v}</Mono>
                <span className="flex gap-1">{stages.map((st) => <Pill key={st} tone={st === 'AWSCURRENT' ? 'green' : 'gray'}>{st}</Pill>)}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Put a new secret value"
        description="Creates a new version and moves AWSCURRENT to it."
        footer={<><Button onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" disabled={!value} loading={m.busy} onClick={async () => { if (await m.run('secrets', 'putValue', { id: s.ARN, value }, 'New version saved')) { setEditing(false); setRev(rev + 1); onChanged(); } }}>Save</Button></>}
      >
        <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={5} placeholder='{"username":"…","password":"…"}' autoFocus />
        <InlineError error={m.error} />
      </Modal>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${s.Name}?`}
        description={force ? 'The secret is deleted immediately, with no recovery window.' : 'The secret is scheduled for deletion in 7 days.'}
        typeToConfirm={s.Name}
        busy={m.busy}
        onConfirm={async () => { if (await m.run('secrets', 'delete', { id: s.ARN, force }, `Deleted ${s.Name}`)) { setConfirm(false); onDeleted(); } }}
      >
        <Checkbox label="Delete immediately (no 7-day recovery window)" checked={force} onChange={setForce} />
      </ConfirmDialog>
    </ListCard>
  );
}

function CreateSecret({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create secret" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || !value} loading={m.busy} onClick={async () => (await m.run('secrets', 'create', { name, value, description }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod/my-app/db" autoFocus /></Field>
      <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Secret value" hint="Plain text or JSON"><Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} /></Field>
      <InlineError error={m.error} />
    </Modal>
  );
}
