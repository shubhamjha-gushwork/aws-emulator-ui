'use client';

import { useState } from 'react';
import { LuPlus, LuSend, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Checkbox, ConfirmDialog, Empty, Field, Input, KV, Modal, Mono, Pill, Select, Textarea } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Topic { arn: string; name: string; attributes: Record<string, string> }
interface Sub { SubscriptionArn: string; Protocol: string; Endpoint: string }

export default function SnsPage() {
  const list = useAws<Topic[]>('sns', 'list');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = list.data?.find((t) => t.arn === sel) ?? null;
  return (
    <>
      <PageHeader serviceId="sns" actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create topic</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ListCard title="Topics" subtitle={list.data ? `${list.data.length} total` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListTopics">
          <DataTable
            rows={list.data ?? []}
            rowKey={(t) => t.arn}
            selectedKey={sel}
            onRowClick={(t) => setSel(t.arn)}
            empty="No topics yet."
            columns={[
              { key: 'name', header: 'Name', cell: (t) => <span className="font-medium text-neutral-900">{t.name}</span> },
              { key: 'type', header: 'Type', cell: (t) => (t.attributes.FifoTopic === 'true' ? <Pill tone="blue">FIFO</Pill> : <Pill tone="gray">Standard</Pill>) },
              { key: 'subs', header: 'Subscriptions', align: 'right', cell: (t) => t.attributes.SubscriptionsConfirmed ?? '—' },
            ]}
          />
        </ListCard>
        {selected ? <TopicDetail key={selected.arn} t={selected} onDeleted={() => { setSel(null); void list.reload(); }} onChanged={list.reload} /> : (
          <ListCard title="Topic details"><Empty>Select a topic to publish and manage subscriptions.</Empty></ListCard>
        )}
      </div>
      <CreateTopic open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void list.reload(); }} />
    </>
  );
}

function TopicDetail({ t, onDeleted, onChanged }: { t: Topic; onDeleted: () => void; onChanged: () => void }) {
  const subs = useAws<Sub[]>('sns', 'subscriptions', { arn: t.arn });
  const [message, setMessage] = useState('{\n  "event": "test"\n}');
  const [subject, setSubject] = useState('');
  const [protocol, setProtocol] = useState('sqs');
  const [endpoint, setEndpoint] = useState('');
  const [grant, setGrant] = useState(true);
  const [confirm, setConfirm] = useState<Sub | 'topic' | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const pub = useMutation();
  const m = useMutation();
  return (
    <ListCard title={t.name} subtitle={<Mono className="text-neutral-500">{t.arn}</Mono>} actions={<Button size="sm" variant="danger" onClick={() => setConfirm('topic')}><LuTrash2 /> Delete</Button>}>
      <div className="flex flex-col gap-6 px-5 py-5">
        <KV items={[['Display name', t.attributes.DisplayName || '—'], ['Owner', t.attributes.Owner], ['Confirmed subscriptions', t.attributes.SubscriptionsConfirmed], ['Pending', t.attributes.SubscriptionsPending]]} />
        <Section title="Publish">
          <Field label="Subject (optional)"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} aria-label="Message" />
          <div>
            <Button variant="primary" loading={pub.busy} onClick={async () => { const r = await pub.run<{ MessageId?: string }>('sns', 'publish', { arn: t.arn, message, subject }); if (r?.MessageId) setLastId(r.MessageId); }}>
              <LuSend /> Publish
            </Button>
            {lastId ? <span className="ml-3 text-xs text-neutral-500">Published <Mono>{lastId}</Mono></span> : null}
          </div>
          <InlineError error={pub.error} />
        </Section>
        <Section title="Subscriptions">
          {subs.error ? <ErrorState error={subs.error} compact what="ListSubscriptionsByTopic" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable
                rows={subs.data ?? []}
                rowKey={(s) => s.SubscriptionArn}
                empty="No subscriptions."
                columns={[
                  { key: 'p', header: 'Protocol', cell: (s) => <Pill tone="blue">{s.Protocol}</Pill> },
                  { key: 'e', header: 'Endpoint', cell: (s) => <Mono className="break-all">{s.Endpoint}</Mono> },
                  { key: 'x', header: '', align: 'right', cell: (s) => <Button size="icon" variant="ghost" aria-label="Unsubscribe" onClick={() => setConfirm(s)}><LuTrash2 /></Button> },
                ]}
              />
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Protocol" className="w-32"><Select value={protocol} onChange={(e) => setProtocol(e.target.value)} options={['sqs', 'lambda', 'http', 'https', 'email']} /></Field>
            <Field label="Endpoint" className="min-w-64 flex-1"><Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={protocol === 'sqs' ? 'arn:aws:sqs:…:queue-name' : ''} /></Field>
            <Button loading={m.busy} disabled={!endpoint} onClick={async () => { if (await m.run('sns', 'subscribe', { arn: t.arn, protocol, endpoint, grantQueuePolicy: grant }, 'Subscribed')) { setEndpoint(''); void subs.reload(); onChanged(); } }}>
              <LuPlus /> Subscribe
            </Button>
          </div>
          {protocol === 'sqs' ? <Checkbox label="Also allow this topic in the queue's access policy (needed for delivery, as on AWS)" checked={grant} onChange={setGrant} /> : null}
        </Section>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'topic' ? `Delete ${t.name}?` : 'Remove subscription?'}
        description={confirm === 'topic' ? 'The topic and its subscriptions are deleted.' : typeof confirm === 'object' && confirm ? confirm.Endpoint : undefined}
        busy={m.busy}
        onConfirm={async () => {
          if (confirm === 'topic') {
            if (await m.run('sns', 'delete', { arn: t.arn }, `Deleted ${t.name}`)) { setConfirm(null); onDeleted(); }
          } else if (confirm && (await m.run('sns', 'unsubscribe', { subscriptionArn: confirm.SubscriptionArn }, 'Unsubscribed'))) {
            setConfirm(null);
            void subs.reload();
            onChanged();
          }
        }}
      />
    </ListCard>
  );
}

function CreateTopic({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [fifo, setFifo] = useState(false);
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create topic" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('sns', 'create', { name, fifo }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <Field label="Topic name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Checkbox label="FIFO topic" checked={fifo} onChange={setFifo} />
      <InlineError error={m.error} />
    </Modal>
  );
}
