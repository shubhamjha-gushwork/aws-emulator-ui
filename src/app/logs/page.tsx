'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LuPlus, LuSearch } from 'react-icons/lu';
import { ListCard } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Field, Input, Modal, Pill, Segmented, TimeAgo, formatBytes } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';
import { groupHref, logSource, type LogSource } from '@/lib/log-sources';

interface Group { logGroupName: string; arn?: string; creationTime?: number; storedBytes?: number; retentionInDays?: number; streamCount?: number; moreStreams?: boolean; lastEventTimestamp?: number }


export default function LogsPage() {
  const router = useRouter();
  const [prefix, setPrefix] = useState('');
  const groups = useAws<Group[]>('logs', 'groups', { prefix, stats: true });
  const ecsGroups = useAws<string[]>('logs', 'ecsGroups');
  const [source, setSource] = useState<'all' | LogSource>('all');
  const classified = (groups.data ?? []).map((g) => ({ ...g, source: logSource(g.logGroupName, ecsGroups.data ?? []) }));
  const count = (s: LogSource) => classified.filter((g) => g.source === s).length;
  const shown = source === 'all' ? classified : classified.filter((g) => g.source === source);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader serviceId="logs" actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create log group</Button>} />
      <ListCard
        title="Log groups"
        subtitle={groups.data ? `${shown.length} of ${classified.length} shown` : undefined}
        loading={groups.loading}
        error={groups.error}
        onReload={() => { void groups.reload(); void ecsGroups.reload(); }}
        hasData={!!groups.data}
        what="DescribeLogGroups"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-neutral-100 px-5 py-3">
          <Segmented
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: `All (${classified.length})` },
              { value: 'lambda', label: `Lambda (${count('lambda')})` },
              { value: 'ecs', label: `ECS (${count('ecs')})` },
              { value: 'other', label: `Other (${count('other')})` },
            ]}
          />
          <div className="relative w-72">
            <LuSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-400" />
            <Input aria-label="Log group prefix" className="h-8 pl-9" placeholder="Search by prefix, e.g. /aws/lambda/" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>
        </div>
        <DataTable
          rows={shown}
          rowKey={(g) => g.logGroupName}
          onRowClick={(g) => router.push(groupHref(g.logGroupName))}
          empty={source === 'all' ? (prefix ? `No log groups start with ${prefix}.` : 'No log groups.') : `No ${source === 'other' ? 'other' : source === 'ecs' ? 'ECS' : 'Lambda'} log groups.`}
          columns={[
            { key: 'n', header: 'Log group', cell: (g) => <a href={groupHref(g.logGroupName)} onClick={(e) => e.preventDefault()} className="break-all font-medium text-primary hover:underline">{g.logGroupName}</a> },
            { key: 'src', header: 'Source', cell: (g) => <Pill tone={g.source === 'lambda' ? 'orange' : g.source === 'ecs' ? 'blue' : 'gray'}>{g.source === 'lambda' ? 'Lambda' : g.source === 'ecs' ? 'ECS' : 'Other'}</Pill> },
            { key: 'st', header: 'Streams', align: 'right', cell: (g) => (g.streamCount === undefined ? '—' : `${g.streamCount}${g.moreStreams ? '+' : ''}`) },
            { key: 's', header: 'Stored', align: 'right', cell: (g) => formatBytes(g.storedBytes) },
            { key: 'l', header: 'Last event', cell: (g) => <span className="text-neutral-500">{g.lastEventTimestamp ? <TimeAgo value={g.lastEventTimestamp} /> : '—'}</span> },
            { key: 'c', header: 'Created', cell: (g) => <span className="text-neutral-500"><TimeAgo value={g.creationTime} /></span> },
          ]}
        />
      </ListCard>
      <CreateGroup open={creating} onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); router.push(groupHref(name)); }} />
    </>
  );
}

function CreateGroup({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create log group" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('logs', 'createGroup', { name }, `Created ${name}`)) && onCreated(name)}>Create</Button></>}>
      <Field label="Log group name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="/my/app" autoFocus /></Field>
      <InlineError error={m.error} />
    </Modal>
  );
}
