'use client';

import { useEffect, useState } from 'react';
import { useSelection } from '@/components/selection';
import { LuPlay, LuPlus, LuScaling, LuSquare, LuTrash2 } from 'react-icons/lu';
import { ListCard } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Checkbox, ConfirmDialog, Empty, Field, Input, JsonBlock, Modal, Mono, Pill, Segmented, Select, Spinner, StatusPill, TimeAgo } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Cluster { clusterArn: string; clusterName: string; status?: string; activeServicesCount?: number; runningTasksCount?: number; pendingTasksCount?: number }
interface Service { serviceArn: string; serviceName: string; status?: string; desiredCount?: number; runningCount?: number; pendingCount?: number; launchType?: string; taskDefinition?: string }
interface Task { taskArn: string; lastStatus?: string; desiredStatus?: string; taskDefinitionArn?: string; startedAt?: string; createdAt?: string; group?: string; launchType?: string; stopCode?: string; stoppedReason?: string }
interface Network { vpcs: { id: string }[]; subnets: { id: string; vpcId: string; az: string; cidr: string }[] }

const short = (arn?: string) => (arn ? arn.split('/').pop() : '');

export default function EcsPage() {
  const clusters = useAws<Cluster[]>('ecs', 'clusters');
  const [sel, setSel] = useSelection('cluster');
  const [td, setTd] = useSelection('taskdef');
  const [name, setName] = useState('');
  const [tab, setTabRaw] = useState<'clusters' | 'taskdefs'>('clusters');
  useEffect(() => { if (td) setTabRaw('taskdefs'); }, [td]);
  const setTab = (t: 'clusters' | 'taskdefs') => { if (sel) setSel(null); if (td) setTd(null); setTabRaw(t); };
  const detail = tab === 'clusters' && sel ? { name: sel.split('/').pop() ?? sel, onBack: () => setSel(null) } : tab === 'taskdefs' && td ? { name: short(td) ?? td, onBack: () => setTd(null) } : undefined;
  const m = useMutation();
  const selected = clusters.data?.find((c) => c.clusterArn === sel) ?? null;
  return (
    <>
      <PageHeader serviceId="ecs" detail={detail} actions={<Segmented value={tab} onChange={setTab} options={[{ value: 'clusters', label: 'Clusters' }, { value: 'taskdefs', label: 'Task definitions' }]} />} />
      {tab === 'taskdefs' ? <TaskDefinitions /> : (
        <div className="flex flex-col gap-6">
          {!sel ? (
          <ListCard
            title="Clusters"
            subtitle={clusters.data ? `${clusters.data.length} total` : undefined}
            loading={clusters.loading}
            error={clusters.error}
            onReload={clusters.reload}
            hasData={!!clusters.data}
            what="ListClusters"
            actions={
              <div className="flex items-center gap-2">
                <Input className="h-8 w-44" placeholder="new-cluster" value={name} onChange={(e) => setName(e.target.value)} />
                <Button size="sm" variant="primary" disabled={!name} loading={m.busy} onClick={async () => { if (await m.run('ecs', 'createCluster', { name }, `Created ${name}`)) { setName(''); void clusters.reload(); } }}><LuPlus /> Create</Button>
              </div>
            }
          >
            <DataTable
              rows={clusters.data ?? []}
              rowKey={(c) => c.clusterArn}
              onRowClick={(c) => setSel(c.clusterArn)}
              empty="No clusters yet."
              columns={[
                { key: 'n', header: 'Name', cell: (c) => <span className="font-medium text-neutral-900">{c.clusterName}</span> },
                { key: 's', header: 'Status', cell: (c) => <StatusPill status={c.status} /> },
                { key: 'sv', header: 'Services', align: 'right', cell: (c) => c.activeServicesCount ?? 0 },
                { key: 'r', header: 'Running tasks', align: 'right', cell: (c) => c.runningTasksCount ?? 0 },
                { key: 'p', header: 'Pending tasks', align: 'right', cell: (c) => c.pendingTasksCount ?? 0 },
              ]}
            />
          </ListCard>
          ) : null}
          {selected ? <ClusterDetail key={selected.clusterArn} c={selected} onChanged={clusters.reload} onDeleted={() => { setSel(null); void clusters.reload(); }} /> : sel && clusters.data ? <ListCard title="Cluster details"><Empty>Not found in this region. It may have been deleted.</Empty></ListCard> : null}
        </div>
      )}
    </>
  );
}

function ClusterDetail({ c, onChanged, onDeleted }: { c: Cluster; onChanged: () => void; onDeleted: () => void }) {
  const [tab, setTab] = useState<'services' | 'tasks'>('services');
  const services = useAws<Service[]>('ecs', 'services', { cluster: c.clusterArn });
  const [taskStatus, setTaskStatus] = useState<'RUNNING' | 'STOPPED'>('RUNNING');
  const tasks = useAws<Task[]>('ecs', 'tasks', { cluster: c.clusterArn, status: taskStatus });
  const [modal, setModal] = useState<'service' | 'task' | null>(null);
  const [scale, setScale] = useState<Service | null>(null);
  const [count, setCount] = useState('1');
  const [confirm, setConfirm] = useState<{ kind: 'cluster' } | { kind: 'service'; s: Service } | { kind: 'task'; t: Task } | null>(null);
  const m = useMutation();
  const reloadAll = () => { void services.reload(); void tasks.reload(); onChanged(); };
  return (
    <ListCard
      title={c.clusterName}
      subtitle={<Mono className="text-neutral-500">{c.clusterArn}</Mono>}
      onReload={reloadAll}
      loading={services.loading || tasks.loading}
      actions={
        <>
          <Segmented value={tab} onChange={setTab} options={[{ value: 'services', label: `Services${services.data ? ` (${services.data.length})` : ''}` }, { value: 'tasks', label: `Tasks${tasks.data ? ` (${tasks.data.length})` : ''}` }]} />
          {tab === 'services' ? <Button size="sm" variant="primary" onClick={() => setModal('service')}><LuPlus /> Service</Button> : <Button size="sm" variant="primary" onClick={() => setModal('task')}><LuPlay /> Run task</Button>}
          <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: 'cluster' })}><LuTrash2 /> Delete</Button>
        </>
      }
    >
      {tab === 'services' ? (
        services.error ? <ErrorState error={services.error} what="DescribeServices" /> : !services.data ? <Spinner /> : (
          <DataTable
            rows={services.data}
            rowKey={(s) => s.serviceArn}
            empty="No services in this cluster."
            columns={[
              { key: 'n', header: 'Service', cell: (s) => <span className="font-medium text-neutral-900">{s.serviceName}</span> },
              { key: 's', header: 'Status', cell: (s) => <StatusPill status={s.status} /> },
              { key: 'td', header: 'Task definition', cell: (s) => <Mono>{short(s.taskDefinition)}</Mono> },
              { key: 'l', header: 'Launch', cell: (s) => <Pill tone="gray">{s.launchType ?? '—'}</Pill> },
              { key: 'c', header: 'Desired / running / pending', align: 'right', cell: (s) => <span className="font-medium text-neutral-900">{s.desiredCount} / {s.runningCount} / {s.pendingCount}</span> },
              { key: 'x', header: '', align: 'right', cell: (s) => <span className="inline-flex gap-1"><Button size="sm" variant="ghost" onClick={() => { setCount(String(s.desiredCount ?? 1)); setScale(s); }}><LuScaling /> Scale</Button><Button size="icon" variant="ghost" aria-label="Delete service" onClick={() => setConfirm({ kind: 'service', s })}><LuTrash2 /></Button></span> },
            ]}
          />
        )
      ) : tasks.error ? <ErrorState error={tasks.error} what="DescribeTasks" /> : !tasks.data ? <Spinner /> : (
        <>
        <div className="flex items-center gap-3 border-b border-neutral-100 px-5 py-3">
          <Segmented value={taskStatus} onChange={setTaskStatus} options={[{ value: 'RUNNING', label: 'Running / pending' }, { value: 'STOPPED', label: 'Stopped' }]} />
          {taskStatus === 'STOPPED' ? <span className="text-xs text-neutral-500">Most recent 100. AWS Emulator holds at most 512 tasks in total, stopped ones included, and frees them only when their cluster is deleted.</span> : null}
        </div>
        <DataTable
          rows={tasks.data}
          rowKey={(t) => t.taskArn}
          empty={taskStatus === 'STOPPED' ? 'No stopped tasks.' : 'No tasks running.'}
          columns={[
            { key: 'id', header: 'Task', cell: (t) => <Mono>{short(t.taskArn)}</Mono> },
            { key: 'g', header: 'Group', cell: (t) => <span className="text-neutral-600">{t.group}</span> },
            { key: 'l', header: 'Last status', cell: (t) => <StatusPill status={t.lastStatus} /> },
            { key: 'd', header: 'Desired', cell: (t) => <StatusPill status={t.desiredStatus} /> },
            { key: 'td', header: 'Task definition', cell: (t) => <Mono>{short(t.taskDefinitionArn)}</Mono> },
            { key: 'c', header: 'Created', cell: (t) => <span className="text-neutral-500"><TimeAgo value={t.createdAt} /></span> },
            ...(taskStatus === 'STOPPED' ? [{ key: 'why', header: 'Stopped reason', cell: (t: Task) => <span className="block max-w-md text-xs text-neutral-600" title={t.stoppedReason}>{t.stopCode ? <Pill tone="red" className="mr-1.5">{t.stopCode}</Pill> : null}{t.stoppedReason}</span> }] : []),
            { key: 'x', header: '', align: 'right', cell: (t) => (t.lastStatus === 'STOPPED' ? null : <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'task', t })}><LuSquare /> Stop</Button>) },
          ]}
        />
        </>
      )}
      <Modal open={!!scale} onClose={() => setScale(null)} title={`Scale ${scale?.serviceName}`} footer={<><Button onClick={() => setScale(null)}>Cancel</Button><Button variant="primary" loading={m.busy} onClick={async () => { if (scale && (await m.run('ecs', 'scaleService', { cluster: c.clusterArn, service: scale.serviceArn, desiredCount: Number(count) }, 'Desired count updated'))) { setScale(null); reloadAll(); } }}>Update</Button></>}>
        <Field label="Desired count"><Input type="number" min={0} value={count} onChange={(e) => setCount(e.target.value)} /></Field>
        <InlineError error={m.error} />
      </Modal>
      <LaunchModal open={modal !== null} kind={modal ?? 'task'} cluster={c.clusterArn} onClose={() => setModal(null)} onDone={() => { setModal(null); setTimeout(reloadAll, 300); }} />
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'cluster' ? `Delete cluster ${c.clusterName}?` : confirm?.kind === 'service' ? `Delete service ${confirm.s.serviceName}?` : 'Stop task?'}
        description={confirm?.kind === 'cluster' ? 'Services must be deleted and tasks stopped first.' : confirm?.kind === 'service' ? 'Force-deletes the service (scales to 0 and removes it).' : confirm?.kind === 'task' ? short(confirm.t.taskArn) : undefined}
        confirmLabel={confirm?.kind === 'task' ? 'Stop' : 'Delete'}
        busy={m.busy}
        onConfirm={async () => {
          if (!confirm) return;
          const ok =
            confirm.kind === 'cluster' ? await m.run('ecs', 'deleteCluster', { cluster: c.clusterArn }, 'Cluster deleted')
              : confirm.kind === 'service' ? await m.run('ecs', 'deleteService', { cluster: c.clusterArn, service: confirm.s.serviceArn }, 'Service deleted')
                : await m.run('ecs', 'stopTask', { cluster: c.clusterArn, task: confirm.t.taskArn }, 'Task stopping');
          if (ok) {
            setConfirm(null);
            if (confirm.kind === 'cluster') onDeleted();
            else reloadAll();
          }
        }}
      />
    </ListCard>
  );
}

function LaunchModal({ open, kind, cluster, onClose, onDone }: { open: boolean; kind: 'service' | 'task'; cluster: string; onClose: () => void; onDone: () => void }) {
  const tds = useAws<string[]>('ecs', 'taskDefinitions', open ? {} : null);
  const net = useAws<Network>('elb', 'network', open ? {} : null);
  const [td, setTd] = useState('');
  const [name, setName] = useState('');
  const [desired, setDesired] = useState('1');
  const [subnet, setSubnet] = useState('');
  const m = useMutation();
  const tdValue = td || tds.data?.[0] || '';
  const subnetValue = subnet || net.data?.subnets[0]?.id || '';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind === 'service' ? 'Create service' : 'Run task'}
      description="Fargate launch type with awsvpc networking."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!tdValue || (kind === 'service' && !name)} loading={m.busy} onClick={async () => {
        const ok = kind === 'service'
          ? await m.run('ecs', 'createService', { cluster, name, taskDefinition: tdValue, desiredCount: Number(desired), subnet: subnetValue }, `Created ${name}`)
          : await m.run('ecs', 'runTask', { cluster, taskDefinition: tdValue, subnet: subnetValue }, 'Task started');
        if (ok) onDone();
      }}>{kind === 'service' ? 'Create' : 'Run'}</Button></>}
    >
      {kind === 'service' ? <Field label="Service name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field> : null}
      <Field label="Task definition" hint={tds.data && !tds.data.length ? 'Register a task definition first (Task definitions tab).' : undefined}>
        <Select value={tdValue} onChange={(e) => setTd(e.target.value)} options={(tds.data ?? []).map((a) => ({ value: a, label: short(a) ?? a }))} />
      </Field>
      {kind === 'service' ? <Field label="Desired count" hint="AWS Emulator stops every task after about 10 seconds, so the service keeps launching replacements. Each stopped task counts toward the emulator's 512-task limit, so scale to 0 when you're done."><Input type="number" min={0} value={desired} onChange={(e) => setDesired(e.target.value)} /></Field> : null}
      <Field label="Subnet"><Select value={subnetValue} onChange={(e) => setSubnet(e.target.value)} options={(net.data?.subnets ?? []).map((s) => ({ value: s.id, label: `${s.id} · ${s.az} · ${s.cidr}` }))} /></Field>
      <InlineError error={m.error ?? tds.error ?? net.error} />
    </Modal>
  );
}

function TaskDefinitions() {
  const list = useAws<string[]>('ecs', 'taskDefinitions');
  const [sel, setSel] = useSelection('taskdef');
  const detail = useAws<unknown>('ecs', 'describeTaskDefinition', sel ? { taskDefinition: sel } : null);
  const [open, setOpen] = useState(false);
  const [family, setFamily] = useState('');
  const [image, setImage] = useState('public.ecr.aws/docker/library/busybox:latest');
  const [port, setPort] = useState('80');
  const [command, setCommand] = useState('echo "hello from ECS"; date');
  const [logs, setLogs] = useState(true);
  const [logGroup, setLogGroup] = useState('');
  const [confirmDereg, setConfirmDereg] = useState(false);
  const m = useMutation();
  return (
    <div className="flex flex-col gap-6">
      {!sel ? (
      <ListCard title="Task definitions" subtitle={list.data ? `${list.data.length} revisions` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListTaskDefinitions" actions={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><LuPlus /> Register</Button>}>
        <DataTable rows={list.data ?? []} rowKey={(a) => a} onRowClick={setSel} empty="No task definitions." columns={[{ key: 'a', header: 'Family:revision', cell: (a) => <Mono>{short(a)}</Mono> }]} />
      </ListCard>
      ) : (
      <ListCard title={short(sel)} loading={detail.loading} error={detail.error} hasData={!!detail.data} actions={sel ? <Button size="sm" variant="danger" onClick={() => setConfirmDereg(true)}><LuTrash2 /> Deregister</Button> : undefined}>
        {detail.data ? <div className="p-5"><JsonBlock value={detail.data} maxHeight={640} /></div> : <Empty>Loading definition…</Empty>}
      </ListCard>
      )}
      <ConfirmDialog
        open={confirmDereg}
        onClose={() => setConfirmDereg(false)}
        title={`Deregister ${short(sel ?? '')}?`}
        description="Deregisters and deletes this revision. Running tasks keep running."
        confirmLabel="Deregister"
        busy={m.busy}
        onConfirm={async () => { if (sel && (await m.run('ecs', 'deregisterTaskDefinition', { taskDefinition: sel }, 'Deregistered'))) { setConfirmDereg(false); setSel(null); void list.reload(); } }}
      />
      <Modal open={open} onClose={() => setOpen(false)} title="Register task definition" description="One Fargate container (256 CPU / 512 MB)." footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!family || !image} loading={m.busy} onClick={async () => { if (await m.run('ecs', 'registerTaskDefinition', { family, image, port, command: command.trim() || undefined, logs, logGroup: logGroup || undefined }, `Registered ${family}`)) { setOpen(false); void list.reload(); } }}>Register</Button></>}>
        <Field label="Family"><Input value={family} onChange={(e) => setFamily(e.target.value)} autoFocus /></Field>
        <Field label="Image"><Input value={image} onChange={(e) => setImage(e.target.value)} /></Field>
        <Field label="Command (optional, run with sh -c)" hint="AWS Emulator runs simple shell commands (echo, sleep…) and sends their output to awslogs; it has no container runtime, so an image's own program (nginx, node, python) doesn't run. Every task stops after about 10 seconds.">
          <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder='echo "hello from ECS"' />
        </Field>
        <Field label="Container port (optional)"><Input value={port} onChange={(e) => setPort(e.target.value)} /></Field>
        <Checkbox checked={logs} onChange={setLogs} label="Send container logs to CloudWatch (awslogs driver)" />
        {logs ? (
          <Field label="Log group" hint="Created if missing. Uses the UI helper role as the task execution role.">
            <Input value={logGroup} onChange={(e) => setLogGroup(e.target.value)} placeholder={`/ecs/${family || '<family>'}`} />
          </Field>
        ) : null}
        <InlineError error={m.error} />
      </Modal>
    </div>
  );
}
