'use client';

import { useState } from 'react';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Checkbox, ConfirmDialog, Empty, Field, Input, KV, Modal, Mono, Pill, Segmented, Select, StatusPill, TimeAgo } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface LB { LoadBalancerArn: string; LoadBalancerName: string; DNSName?: string; Scheme?: string; Type?: string; State?: { Code?: string }; VpcId?: string; CreatedTime?: string; AvailabilityZones?: { ZoneName?: string; SubnetId?: string }[] }
interface Listener { ListenerArn: string; Port?: number; Protocol?: string; DefaultActions?: { Type?: string; TargetGroupArn?: string }[] }
interface TG { TargetGroupArn: string; TargetGroupName: string; Protocol?: string; Port?: number; VpcId?: string; TargetType?: string; LoadBalancerArns?: string[]; HealthCheckPath?: string }
interface Health { Target?: { Id?: string; Port?: number }; TargetHealth?: { State?: string; Reason?: string; Description?: string } }
interface Network { vpcs: { id: string; cidr: string; isDefault?: boolean }[]; subnets: { id: string; vpcId: string; az: string; cidr: string }[] }

const tgName = (arn?: string) => arn?.split(':targetgroup/')[1]?.split('/')[0] ?? arn;

export default function ElbPage() {
  const [tab, setTab] = useState<'lbs' | 'tgs'>('lbs');
  return (
    <>
      <PageHeader serviceId="elb" subtitle="Application and network load balancers (ELBv2): listeners, target groups, target health" actions={<Segmented value={tab} onChange={setTab} options={[{ value: 'lbs', label: 'Load balancers' }, { value: 'tgs', label: 'Target groups' }]} />} />
      {tab === 'lbs' ? <LoadBalancers /> : <TargetGroups />}
    </>
  );
}

function LoadBalancers() {
  const lbs = useAws<LB[]>('elb', 'loadBalancers');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = lbs.data?.find((l) => l.LoadBalancerArn === sel) ?? null;
  return (
    <div className="flex flex-col gap-6">
      <ListCard title="Load balancers" subtitle={lbs.data ? `${lbs.data.length} total` : undefined} loading={lbs.loading} error={lbs.error} onReload={lbs.reload} hasData={!!lbs.data} what="DescribeLoadBalancers" actions={<Button size="sm" variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create ALB</Button>}>
        <DataTable
          rows={lbs.data ?? []}
          rowKey={(l) => l.LoadBalancerArn}
          selectedKey={sel}
          onRowClick={(l) => setSel(l.LoadBalancerArn)}
          empty="No load balancers."
          columns={[
            { key: 'n', header: 'Name', cell: (l) => <span className="font-medium text-neutral-900">{l.LoadBalancerName}</span> },
            { key: 't', header: 'Type', cell: (l) => <Pill tone="blue">{l.Type}</Pill> },
            { key: 's', header: 'Scheme', cell: (l) => <Pill tone="gray">{l.Scheme}</Pill> },
            { key: 'st', header: 'State', cell: (l) => <StatusPill status={l.State?.Code} /> },
            { key: 'd', header: 'DNS name', cell: (l) => <Mono>{l.DNSName}</Mono> },
            { key: 'v', header: 'VPC', cell: (l) => <Mono>{l.VpcId}</Mono> },
          ]}
        />
      </ListCard>
      {selected ? <LbDetail key={selected.LoadBalancerArn} lb={selected} onDeleted={() => { setSel(null); void lbs.reload(); }} /> : null}
      <CreateLb open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void lbs.reload(); }} />
    </div>
  );
}

function LbDetail({ lb, onDeleted }: { lb: LB; onDeleted: () => void }) {
  const listeners = useAws<Listener[]>('elb', 'listeners', { arn: lb.LoadBalancerArn });
  const tgs = useAws<TG[]>('elb', 'targetGroups', {});
  const [port, setPort] = useState('8080');
  const [tg, setTg] = useState('');
  const [confirm, setConfirm] = useState<Listener | 'lb' | null>(null);
  const m = useMutation();
  const tgValue = tg || tgs.data?.[0]?.TargetGroupArn || '';
  return (
    <ListCard title={lb.LoadBalancerName} subtitle={<Mono className="text-neutral-500">{lb.LoadBalancerArn}</Mono>} actions={<Button size="sm" variant="danger" onClick={() => setConfirm('lb')}><LuTrash2 /> Delete</Button>}>
      <div className="grid grid-cols-1 gap-6 px-5 py-5 lg:grid-cols-2">
        <KV items={[['DNS name', <Mono key="d">{lb.DNSName}</Mono>], ['Created', <TimeAgo key="c" value={lb.CreatedTime} />], ['Availability zones', lb.AvailabilityZones?.map((z) => z.ZoneName).join(', ')], ['Subnets', lb.AvailabilityZones?.map((z) => z.SubnetId).join(', ')]]} />
        <Section title="Listeners">
          {listeners.error ? <ErrorState error={listeners.error} compact what="DescribeListeners" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable rows={listeners.data ?? []} rowKey={(l) => l.ListenerArn} empty="No listeners." columns={[
                { key: 'p', header: 'Port', cell: (l) => <span className="font-medium">{l.Protocol}:{l.Port}</span> },
                { key: 'a', header: 'Default action', cell: (l) => <span className="text-neutral-700">{l.DefaultActions?.map((a) => `${a.Type} → ${tgName(a.TargetGroupArn) ?? ''}`).join(', ')}</span> },
                { key: 'x', header: '', align: 'right', cell: (l) => <Button size="icon" variant="ghost" aria-label="Delete listener" onClick={() => setConfirm(l)}><LuTrash2 /></Button> },
              ]} />
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="HTTP port" className="w-24"><Input value={port} onChange={(e) => setPort(e.target.value)} /></Field>
            <Field label="Forward to" className="min-w-48 flex-1"><Select value={tgValue} onChange={(e) => setTg(e.target.value)} options={(tgs.data ?? []).map((t) => ({ value: t.TargetGroupArn, label: t.TargetGroupName }))} /></Field>
            <Button disabled={!tgValue} loading={m.busy} onClick={async () => { if (await m.run('elb', 'createListener', { arn: lb.LoadBalancerArn, port, targetGroupArn: tgValue }, `Listener :${port} created`)) void listeners.reload(); }}><LuPlus /> Add listener</Button>
          </div>
        </Section>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'lb' ? `Delete ${lb.LoadBalancerName}?` : `Delete listener ${confirm ? `${confirm.Protocol}:${confirm.Port}` : ''}?`}
        typeToConfirm={confirm === 'lb' ? lb.LoadBalancerName : undefined}
        busy={m.busy}
        onConfirm={async () => {
          if (confirm === 'lb') {
            if (await m.run('elb', 'deleteLoadBalancer', { arn: lb.LoadBalancerArn }, 'Load balancer deleted')) { setConfirm(null); onDeleted(); }
          } else if (confirm && (await m.run('elb', 'deleteListener', { listenerArn: confirm.ListenerArn }, 'Listener deleted'))) {
            setConfirm(null);
            void listeners.reload();
          }
        }}
      />
    </ListCard>
  );
}

function CreateLb({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const net = useAws<Network>('elb', 'network', open ? {} : null);
  const [name, setName] = useState('');
  const [scheme, setScheme] = useState('internal');
  const [picked, setPicked] = useState<string[]>([]);
  const m = useMutation();
  const vpc = net.data?.vpcs.find((v) => v.isDefault)?.id ?? net.data?.vpcs[0]?.id;
  const subnets = (net.data?.subnets ?? []).filter((s) => s.vpcId === vpc);
  return (
    <Modal open={open} onClose={onClose} title="Create application load balancer" description="Pick at least two subnets in different AZs." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || picked.length < 2} loading={m.busy} onClick={async () => (await m.run('elb', 'createLoadBalancer', { name, scheme, subnets: picked }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <div className="grid grid-cols-[1fr_160px] gap-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Scheme"><Select value={scheme} onChange={(e) => setScheme(e.target.value)} options={['internal', 'internet-facing']} /></Field>
      </div>
      <Field label={`Subnets in ${vpc ?? '…'}`}>
        <div className="flex max-h-48 flex-col gap-1.5 overflow-auto rounded-md border border-neutral-100 p-2">
          {subnets.map((s) => <Checkbox key={s.id} label={`${s.id} · ${s.az} · ${s.cidr}`} checked={picked.includes(s.id)} onChange={(v) => setPicked(v ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />)}
          {!subnets.length ? <span className="text-sm text-neutral-400">No subnets found.</span> : null}
        </div>
      </Field>
      <InlineError error={m.error ?? net.error} />
    </Modal>
  );
}

function TargetGroups() {
  const tgs = useAws<TG[]>('elb', 'targetGroups', {});
  const net = useAws<Network>('elb', 'network');
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [port, setPort] = useState('80');
  const [protocol, setProtocol] = useState('HTTP');
  const m = useMutation();
  const selected = tgs.data?.find((t) => t.TargetGroupArn === sel) ?? null;
  const vpc = net.data?.vpcs.find((v) => v.isDefault)?.id ?? net.data?.vpcs[0]?.id;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ListCard title="Target groups" subtitle={tgs.data ? `${tgs.data.length} total` : undefined} loading={tgs.loading} error={tgs.error} onReload={tgs.reload} hasData={!!tgs.data} what="DescribeTargetGroups" actions={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><LuPlus /> Create</Button>}>
        <DataTable rows={tgs.data ?? []} rowKey={(t) => t.TargetGroupArn} selectedKey={sel} onRowClick={(t) => setSel(t.TargetGroupArn)} empty="No target groups." columns={[
          { key: 'n', header: 'Name', cell: (t) => <span className="font-medium text-neutral-900">{t.TargetGroupName}</span> },
          { key: 'p', header: 'Protocol', cell: (t) => `${t.Protocol}:${t.Port}` },
          { key: 't', header: 'Target type', cell: (t) => <Pill tone="gray">{t.TargetType}</Pill> },
          { key: 'l', header: 'LBs', align: 'right', cell: (t) => t.LoadBalancerArns?.length ?? 0 },
        ]} />
      </ListCard>
      {selected ? <TgDetail key={selected.TargetGroupArn} tg={selected} onDeleted={() => { setSel(null); void tgs.reload(); }} /> : <ListCard title="Targets"><Empty>Select a target group to see target health.</Empty></ListCard>}
      <Modal open={open} onClose={() => setOpen(false)} title="Create target group" description={`IP targets in ${vpc ?? '…'}`} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name || !vpc} loading={m.busy} onClick={async () => { if (await m.run('elb', 'createTargetGroup', { name, port, protocol, vpcId: vpc }, `Created ${name}`)) { setOpen(false); setName(''); void tgs.reload(); } }}>Create</Button></>}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Protocol"><Select value={protocol} onChange={(e) => setProtocol(e.target.value)} options={['HTTP', 'HTTPS', 'TCP']} /></Field>
          <Field label="Port"><Input value={port} onChange={(e) => setPort(e.target.value)} /></Field>
        </div>
        <InlineError error={m.error} />
      </Modal>
    </div>
  );
}

function TgDetail({ tg, onDeleted }: { tg: TG; onDeleted: () => void }) {
  const health = useAws<Health[]>('elb', 'targetHealth', { targetGroupArn: tg.TargetGroupArn });
  const [ip, setIp] = useState('');
  const [confirm, setConfirm] = useState(false);
  const m = useMutation();
  return (
    <ListCard title={tg.TargetGroupName} subtitle={<Mono className="text-neutral-500">{tg.TargetGroupArn}</Mono>} onReload={health.reload} loading={health.loading} actions={<Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>}>
      <div className="flex flex-col gap-5 px-5 py-5">
        <KV items={[['VPC', <Mono key="v">{tg.VpcId}</Mono>], ['Health check path', tg.HealthCheckPath ?? '—']]} />
        <Section title="Registered targets">
          {health.error ? <ErrorState error={health.error} compact what="DescribeTargetHealth" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable rows={health.data ?? []} rowKey={(h) => `${h.Target?.Id}:${h.Target?.Port}`} empty="No targets registered." columns={[
                { key: 'i', header: 'Target', cell: (h) => <Mono>{h.Target?.Id}:{h.Target?.Port}</Mono> },
                { key: 's', header: 'Health', cell: (h) => <StatusPill status={h.TargetHealth?.State} /> },
                { key: 'r', header: 'Reason', cell: (h) => <span className="text-xs text-neutral-500">{h.TargetHealth?.Description ?? h.TargetHealth?.Reason ?? ''}</span> },
              ]} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <Field label="Register IP target (inside the VPC)" className="flex-1"><Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="172.31.0.20" /></Field>
            <Button disabled={!ip} loading={m.busy} onClick={async () => { if (await m.run('elb', 'registerTarget', { targetGroupArn: tg.TargetGroupArn, targetId: ip, port: tg.Port }, 'Target registered')) { setIp(''); void health.reload(); } }}><LuPlus /> Register</Button>
          </div>
        </Section>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${tg.TargetGroupName}?`} description="Target groups used by a listener can't be deleted." busy={m.busy} onConfirm={async () => { if (await m.run('elb', 'deleteTargetGroup', { targetGroupArn: tg.TargetGroupArn }, 'Target group deleted')) { setConfirm(false); onDeleted(); } }} />
    </ListCard>
  );
}
