'use client';

import { useState } from 'react';
import { useSelection } from '@/components/selection';
import { LuDownload, LuEraser, LuPlus, LuSend, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Checkbox, ConfirmDialog, Empty, Field, Input, JsonBlock, KV, Modal, Mono, Pill, Textarea } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Queue { url: string; name: string; attributes: Record<string, string> }
interface Msg { MessageId: string; ReceiptHandle: string; Body: string; Attributes?: Record<string, string> }

export default function SqsPage() {
  const list = useAws<Queue[]>('sqs', 'list');
  const [sel, setSel] = useSelection('queue');
  const [creating, setCreating] = useState(false);
  const selected = list.data?.find((q) => q.url === sel || q.url.endsWith('/' + sel) || q.url.split('/').pop() === sel) ?? null;
  return (
    <>
      <PageHeader serviceId="sqs" detail={sel ? { name: sel.split('/').pop()!, onBack: () => setSel(null) } : undefined} actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create queue</Button>} />
      <div className="flex flex-col gap-6">
        {!sel ? (
        <ListCard title="Queues" subtitle={list.data ? `${list.data.length} total` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListQueues">
          <DataTable
            rows={list.data ?? []}
            rowKey={(q) => q.url}
            onRowClick={(q) => setSel(q.url)}
            empty="No queues yet."
            columns={[
              { key: 'name', header: 'Name', cell: (q) => <span className="font-medium text-neutral-900">{q.name}</span> },
              { key: 'type', header: 'Type', cell: (q) => (q.attributes.FifoQueue === 'true' ? <Pill tone="blue">FIFO</Pill> : <Pill tone="gray">Standard</Pill>) },
              { key: 'avail', header: 'Available', align: 'right', cell: (q) => <span className="font-medium text-neutral-900">{q.attributes.ApproximateNumberOfMessages ?? '—'}</span> },
              { key: 'flight', header: 'In flight', align: 'right', cell: (q) => q.attributes.ApproximateNumberOfMessagesNotVisible ?? '—' },
              { key: 'delayed', header: 'Delayed', align: 'right', cell: (q) => q.attributes.ApproximateNumberOfMessagesDelayed ?? '—' },
            ]}
          />
        </ListCard>
        ) : null}
        {selected ? <QueueDetail key={selected.url} q={selected} onChanged={list.reload} onDeleted={() => { setSel(null); void list.reload(); }} /> : sel && list.data ? <ListCard title="Queue details"><Empty>Not found in this region. It may have been deleted.</Empty></ListCard> : null}
      </div>
      <CreateQueue open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void list.reload(); }} />
    </>
  );
}

function QueueDetail({ q, onChanged, onDeleted }: { q: Queue; onChanged: () => void; onDeleted: () => void }) {
  const fifo = q.attributes.FifoQueue === 'true';
  const [body, setBody] = useState('{\n  "hello": "from AWS Emulator"\n}');
  const [groupId, setGroupId] = useState('default');
  const [vt, setVt] = useState('30');
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [confirm, setConfirm] = useState<'purge' | 'delete' | null>(null);
  const m = useMutation();
  const rx = useMutation();
  const danger = useMutation();
  return (
    <ListCard
      title={q.name}
      subtitle={<Mono className="text-neutral-500">{q.url}</Mono>}
      actions={
        <>
          <Button size="sm" onClick={() => setConfirm('purge')}><LuEraser /> Purge</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm('delete')}><LuTrash2 /> Delete</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 px-5 py-5">
        <KV
          items={[
            ['ARN', <Mono key="a">{q.attributes.QueueArn}</Mono>],
            ['Visibility timeout', `${q.attributes.VisibilityTimeout ?? '—'}s`],
            ['Retention', q.attributes.MessageRetentionPeriod ? `${Math.round(Number(q.attributes.MessageRetentionPeriod) / 86400)} days` : '—'],
            ['Redrive policy', q.attributes.RedrivePolicy ? <Mono key="r">{q.attributes.RedrivePolicy}</Mono> : 'None'],
          ]}
        />
        <Section title="Send message">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} aria-label="Message body" />
          <div className="flex flex-wrap items-end gap-3">
            {fifo ? <Field label="Message group ID" className="w-48"><Input value={groupId} onChange={(e) => setGroupId(e.target.value)} /></Field> : null}
            <Button variant="primary" loading={m.busy} onClick={async () => (await m.run('sqs', 'send', { url: q.url, body, groupId }, 'Message sent')) && onChanged()}>
              <LuSend /> Send
            </Button>
          </div>
        </Section>
        <Section title="Receive messages">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Visibility timeout (s)" hint="0 = peek without hiding" className="w-48"><Input type="number" min={0} value={vt} onChange={(e) => setVt(e.target.value)} /></Field>
            <Button loading={rx.busy} data-testid="receive-button" onClick={async () => { const r = await rx.run<Msg[]>('sqs', 'receive', { url: q.url, visibilityTimeout: Number(vt), max: 10 }); if (r) { setMsgs(r); onChanged(); } }}>
              <LuDownload /> Poll (up to 10)
            </Button>
          </div>
          {msgs ? (
            msgs.length ? (
              <div className="flex flex-col gap-2">
                {msgs.map((msg) => (
                  <div key={msg.ReceiptHandle} className="rounded-lg border border-neutral-100">
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100 bg-neutral-25 px-3 py-1.5">
                      <Mono className="truncate text-neutral-500">{msg.MessageId}</Mono>
                      <div className="flex items-center gap-2">
                        <Pill tone="gray">received ×{msg.Attributes?.ApproximateReceiveCount ?? 1}</Pill>
                        <Button size="sm" variant="ghost" onClick={async () => { if (await m.run('sqs', 'deleteMessage', { url: q.url, receiptHandle: msg.ReceiptHandle }, 'Message deleted')) { setMsgs(msgs.filter((x) => x !== msg)); onChanged(); } }}>
                          <LuTrash2 /> Delete
                        </Button>
                      </div>
                    </div>
                    <JsonBlock value={msg.Body} className="rounded-t-none border-0" maxHeight={180} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-neutral-400">No messages available.</p>
            )
          ) : null}
          <InlineError error={rx.error} />
        </Section>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'purge' ? `Purge ${q.name}?` : `Delete ${q.name}?`}
        description={confirm === 'purge' ? 'All messages in the queue are deleted.' : 'The queue and all its messages are deleted.'}
        confirmLabel={confirm === 'purge' ? 'Purge' : 'Delete'}
        busy={danger.busy}
        onConfirm={async () => {
          if (confirm === 'purge') {
            if (await danger.run('sqs', 'purge', { url: q.url }, `Purged ${q.name}`)) { setConfirm(null); setMsgs(null); onChanged(); }
          } else if (await danger.run('sqs', 'delete', { url: q.url }, `Deleted ${q.name}`)) {
            setConfirm(null);
            onDeleted();
          }
        }}
      />
    </ListCard>
  );
}

function CreateQueue({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [fifo, setFifo] = useState(false);
  const [vt, setVt] = useState('30');
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create queue" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('sqs', 'create', { name, fifo, visibilityTimeout: vt }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <Field label="Queue name" hint={fifo ? '.fifo is appended automatically' : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Visibility timeout (s)"><Input type="number" value={vt} onChange={(e) => setVt(e.target.value)} /></Field>
      <Checkbox label="FIFO queue (content-based deduplication)" checked={fifo} onChange={setFifo} />
      <InlineError error={m.error} />
    </Modal>
  );
}
