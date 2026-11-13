'use client';

import { useEffect, useState } from 'react';
import { useSelection } from '@/components/selection';
import { LuPlus, LuPower, LuSend, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Card, CardHeader, ConfirmDialog, Empty, Field, Input, JsonBlock, KV, Modal, Mono, Pill, Segmented, Select, StatusPill, Textarea, TimeAgo } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Bus { Name: string; Arn: string; CreationTime?: string }
interface Rule { Name: string; Arn: string; EventPattern?: string; ScheduleExpression?: string; State?: string; Description?: string; EventBusName?: string }
interface Target { Id: string; Arn: string; Input?: string; RoleArn?: string }
interface ScheduleSummary { Name: string; GroupName?: string; State?: string; Arn?: string; Target?: { Arn?: string }; CreationDate?: string }

export default function EventBridgePage() {
  const [tab, setTabRaw] = useState<'rules' | 'buses' | 'scheduler'>('rules');
  const [rule, setRule] = useSelection('rule');
  const [sched, setSched] = useSelection('schedule');
  useEffect(() => { if (sched) setTabRaw('scheduler'); }, [sched]);
  const setTab = (t: 'rules' | 'buses' | 'scheduler') => { if (rule) setRule(null); if (sched) setSched(null); setTabRaw(t); };
  const detail = tab === 'rules' && rule ? { name: rule, onBack: () => setRule(null) } : tab === 'scheduler' && sched ? { name: sched.split('/').pop()!, onBack: () => setSched(null) } : undefined;
  return (
    <>
      <PageHeader serviceId="eventbridge" detail={detail} actions={<Segmented value={tab} onChange={setTab} options={[{ value: 'rules', label: 'Rules' }, { value: 'buses', label: 'Event buses' }, { value: 'scheduler', label: 'Scheduler' }]} />} />
      {tab === 'rules' ? <RulesTab /> : tab === 'buses' ? <BusesTab /> : <SchedulerTab />}
    </>
  );
}

function RulesTab() {
  const buses = useAws<Bus[]>('eventbridge', 'buses');
  const [busParam, setBusParam] = useSelection('bus');
  const bus = busParam ?? 'default';
  const setBus = (b: string) => setBusParam(b === 'default' ? null : b);
  const rules = useAws<Rule[]>('eventbridge', 'rules', { bus });
  const [sel, setSel] = useSelection('rule');
  const [creating, setCreating] = useState(false);
  const selected = rules.data?.find((r) => r.Name === sel) ?? null;
  return (
    <div className="flex flex-col gap-6">
        {!sel ? (
        <ListCard
          title="Rules"
          subtitle={rules.data ? `${rules.data.length} on ${bus}` : undefined}
          loading={rules.loading}
          error={rules.error}
          onReload={rules.reload}
          hasData={!!rules.data}
          what="ListRules"
          actions={
            <>
              <Select aria-label="Event bus" className="h-8 w-40" value={bus} onChange={(e) => setBus(e.target.value)} options={(buses.data ?? [{ Name: 'default' } as Bus]).map((b) => b.Name)} />
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}><LuPlus /> Rule</Button>
            </>
          }
        >
          <DataTable
            rows={rules.data ?? []}
            rowKey={(r) => r.Name}
            onRowClick={(r) => setSel(r.Name)}
            empty="No rules on this bus."
            columns={[
              { key: 'n', header: 'Name', cell: (r) => <span className="font-medium text-neutral-900">{r.Name}</span> },
              { key: 't', header: 'Trigger', cell: (r) => (r.ScheduleExpression ? <Pill tone="blue">{r.ScheduleExpression}</Pill> : <Pill tone="gray">Event pattern</Pill>) },
              { key: 's', header: 'State', cell: (r) => <StatusPill status={r.State} /> },
            ]}
          />
        </ListCard>
        ) : null}
        {selected ? <RuleDetail key={selected.Arn} rule={selected} bus={bus} onChanged={rules.reload} onDeleted={() => { setSel(null); void rules.reload(); }} /> : sel && rules.data ? (
          <ListCard title="Rule details"><Empty>No rule named {sel} on bus {bus}.</Empty></ListCard>
        ) : null}
      {!sel ? <PutEvents buses={(buses.data ?? []).map((b) => b.Name)} /> : null}
      <CreateRule open={creating} bus={bus} onClose={() => setCreating(false)} onCreated={(n) => { setCreating(false); setSel(n); void rules.reload(); }} />
    </div>
  );
}

function RuleDetail({ rule, bus, onChanged, onDeleted }: { rule: Rule; bus: string; onChanged: () => void; onDeleted: () => void }) {
  const targets = useAws<Target[]>('eventbridge', 'targets', { name: rule.Name, bus });
  const [confirm, setConfirm] = useState<Target | 'rule' | null>(null);
  const [tid, setTid] = useState('');
  const [tarn, setTarn] = useState('');
  const [tinput, setTinput] = useState('');
  const m = useMutation();
  const enabled = rule.State === 'ENABLED';
  return (
    <ListCard
      title={rule.Name}
      subtitle={<Mono className="text-neutral-500">{rule.Arn}</Mono>}
      actions={
        <>
          <Button size="sm" loading={m.busy} onClick={async () => (await m.run('eventbridge', 'setRuleState', { name: rule.Name, bus, enabled: !enabled }, enabled ? 'Rule disabled' : 'Rule enabled')) && onChanged()}>
            <LuPower /> {enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm('rule')}><LuTrash2 /> Delete</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 px-5 py-5">
        <KV items={[['State', <StatusPill key="s" status={rule.State} />], ['Event bus', rule.EventBusName ?? bus], ['Schedule', rule.ScheduleExpression ?? '—'], ['Description', rule.Description || '—']]} />
        {rule.EventPattern ? <Section title="Event pattern"><JsonBlock value={rule.EventPattern} maxHeight={200} /></Section> : null}
        <Section title="Targets">
          {targets.error ? <ErrorState error={targets.error} compact what="ListTargetsByRule" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable
                rows={targets.data ?? []}
                rowKey={(t) => t.Id}
                empty="No targets."
                columns={[
                  { key: 'i', header: 'ID', cell: (t) => <span className="font-medium">{t.Id}</span> },
                  { key: 'a', header: 'ARN', cell: (t) => <Mono className="break-all">{t.Arn}</Mono> },
                  { key: 'x', header: '', align: 'right', cell: (t) => <Button size="icon" variant="ghost" aria-label="Remove target" onClick={() => setConfirm(t)}><LuTrash2 /></Button> },
                ]}
              />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
            <Field label="Target ID"><Input value={tid} onChange={(e) => setTid(e.target.value)} placeholder="my-target" /></Field>
            <Field label="Target ARN"><Input value={tarn} onChange={(e) => setTarn(e.target.value)} placeholder="arn:aws:sqs:… / arn:aws:lambda:…" /></Field>
          </div>
          <Field label="Constant input (optional JSON)"><Input value={tinput} onChange={(e) => setTinput(e.target.value)} placeholder='{"key":"value"}' /></Field>
          <div>
            <Button disabled={!tid || !tarn} loading={m.busy} onClick={async () => { if (await m.run('eventbridge', 'putTarget', { name: rule.Name, bus, id: tid, arn: tarn, input: tinput }, 'Target added')) { setTid(''); setTarn(''); setTinput(''); void targets.reload(); } }}>
              <LuPlus /> Add target
            </Button>
          </div>
        </Section>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'rule' ? `Delete rule ${rule.Name}?` : 'Remove target?'}
        description={confirm === 'rule' ? 'Its targets are removed first, then the rule is deleted.' : confirm ? confirm.Arn : undefined}
        busy={m.busy}
        onConfirm={async () => {
          if (confirm === 'rule') {
            if (await m.run('eventbridge', 'deleteRule', { name: rule.Name, bus }, `Deleted ${rule.Name}`)) { setConfirm(null); onDeleted(); }
          } else if (confirm && (await m.run('eventbridge', 'removeTarget', { name: rule.Name, bus, id: confirm.Id }, 'Target removed'))) {
            setConfirm(null);
            void targets.reload();
          }
        }}
      />
    </ListCard>
  );
}

function CreateRule({ open, bus, onClose, onCreated }: { open: boolean; bus: string; onClose: () => void; onCreated: (n: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'pattern' | 'schedule'>('pattern');
  const [pattern, setPattern] = useState('{\n  "source": ["my.app"]\n}');
  const [schedule, setSchedule] = useState('rate(5 minutes)');
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title={`Create rule on ${bus}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('eventbridge', 'putRule', { name, bus, ...(kind === 'pattern' ? { pattern } : { schedule }) }, `Created ${name}`)) && onCreated(name)}>Create</Button></>}>
      <Field label="Rule name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div><Segmented value={kind} onChange={setKind} options={[{ value: 'pattern', label: 'Event pattern' }, { value: 'schedule', label: 'Schedule' }]} /></div>
      {kind === 'pattern' ? <Field label="Event pattern (JSON)"><Textarea value={pattern} onChange={(e) => setPattern(e.target.value)} rows={5} /></Field> : <Field label="Schedule expression" hint="rate(5 minutes) or cron(0 12 * * ? *) — default bus only"><Input value={schedule} onChange={(e) => setSchedule(e.target.value)} /></Field>}
      <InlineError error={m.error} />
    </Modal>
  );
}

function PutEvents({ buses }: { buses: string[] }) {
  const [bus, setBus] = useState('default');
  const [source, setSource] = useState('my.app');
  const [detailType, setDetailType] = useState('Test');
  const [detail, setDetail] = useState('{\n  "orderId": "o-1"\n}');
  const [result, setResult] = useState<unknown>(null);
  const m = useMutation();
  return (
    <Card>
      <CardHeader title="Put events" subtitle="Send a custom event to a bus (PutEvents)" />
      <div className="grid grid-cols-1 gap-4 px-5 py-5 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Event bus"><Select value={bus} onChange={(e) => setBus(e.target.value)} options={buses.length ? buses : ['default']} /></Field>
            <Field label="Source"><Input value={source} onChange={(e) => setSource(e.target.value)} /></Field>
            <Field label="Detail type"><Input value={detailType} onChange={(e) => setDetailType(e.target.value)} /></Field>
          </div>
          <Field label="Detail (JSON)"><Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={5} /></Field>
          <div><Button variant="primary" loading={m.busy} onClick={async () => setResult((await m.run('eventbridge', 'putEvents', { bus, source, detailType, detail }, 'Event sent')) ?? null)}><LuSend /> Send event</Button></div>
          <InlineError error={m.error} />
        </div>
        <div>{result ? <><div className="mb-1 text-xs text-neutral-500">Response</div><JsonBlock value={result} maxHeight={260} /></> : <Empty>The PutEvents response shows here.</Empty>}</div>
      </div>
    </Card>
  );
}

function BusesTab() {
  const buses = useAws<Bus[]>('eventbridge', 'buses');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<Bus | null>(null);
  const m = useMutation();
  return (
    <ListCard
      title="Event buses"
      loading={buses.loading}
      error={buses.error}
      onReload={buses.reload}
      hasData={!!buses.data}
      what="ListEventBuses"
      actions={
        <div className="flex items-center gap-2">
          <Input className="h-8 w-48" placeholder="new-bus-name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" variant="primary" disabled={!name} loading={m.busy} onClick={async () => { if (await m.run('eventbridge', 'createBus', { name }, `Created ${name}`)) { setName(''); void buses.reload(); } }}><LuPlus /> Create</Button>
        </div>
      }
    >
      <DataTable
        rows={buses.data ?? []}
        rowKey={(b) => b.Arn}
        columns={[
          { key: 'n', header: 'Name', cell: (b) => <span className="font-medium text-neutral-900">{b.Name}</span> },
          { key: 'a', header: 'ARN', cell: (b) => <Mono>{b.Arn}</Mono> },
          { key: 'c', header: 'Created', cell: (b) => <span className="text-neutral-500"><TimeAgo value={b.CreationTime} /></span> },
          { key: 'x', header: '', align: 'right', cell: (b) => (b.Name === 'default' ? null : <Button size="icon" variant="ghost" aria-label="Delete bus" onClick={() => setConfirm(b)}><LuTrash2 /></Button>) },
        ]}
      />
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} title={`Delete bus ${confirm?.Name}?`} description="Rules on the bus must be deleted first." busy={m.busy} onConfirm={async () => { if (confirm && (await m.run('eventbridge', 'deleteBus', { name: confirm.Name }, 'Bus deleted'))) { setConfirm(null); void buses.reload(); } }} />
    </ListCard>
  );
}

function SchedulerTab() {
  const schedules = useAws<ScheduleSummary[]>('eventbridge', 'schedules', {});
  const [selKey, setSelKey] = useSelection('schedule');
  const keyOf = (s: ScheduleSummary) => `${s.GroupName ?? 'default'}/${s.Name}`;
  const sel = schedules.data?.find((s) => keyOf(s) === selKey) ?? null;
  const setSel = (s: ScheduleSummary | null) => setSelKey(s ? keyOf(s) : null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      {!selKey ? (
      <ListCard title="Schedules" subtitle="EventBridge Scheduler" loading={schedules.loading} error={schedules.error} onReload={schedules.reload} hasData={!!schedules.data} what="ListSchedules" actions={<Button size="sm" variant="primary" onClick={() => setCreating(true)}><LuPlus /> Schedule</Button>}>
        <DataTable
          rows={schedules.data ?? []}
          rowKey={(s) => `${s.GroupName}/${s.Name}`}
          onRowClick={setSel}
          empty="No schedules yet."
          columns={[
            { key: 'n', header: 'Name', cell: (s) => <span className="font-medium text-neutral-900">{s.Name}</span> },
            { key: 'g', header: 'Group', cell: (s) => <Pill tone="gray">{s.GroupName ?? 'default'}</Pill> },
            { key: 's', header: 'State', cell: (s) => <StatusPill status={s.State} /> },
          ]}
        />
      </ListCard>
      ) : null}
      {sel ? <ScheduleDetail key={keyOf(sel)} s={sel} onDeleted={() => { setSel(null); void schedules.reload(); }} /> : selKey && schedules.data ? <ListCard title="Schedule details"><Empty>Not found in this region. It may have been deleted.</Empty></ListCard> : null}
      <CreateSchedule open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void schedules.reload(); }} />
    </div>
  );
}

function ScheduleDetail({ s, onDeleted }: { s: ScheduleSummary; onDeleted: () => void }) {
  const d = useAws<Record<string, unknown> & { ScheduleExpression?: string; Target?: { Arn?: string; Input?: string; RoleArn?: string }; State?: string }>('eventbridge', 'getSchedule', { name: s.Name, group: s.GroupName });
  const [confirm, setConfirm] = useState(false);
  const m = useMutation();
  return (
    <ListCard title={s.Name} subtitle={<Mono className="text-neutral-500">{s.Arn}</Mono>} loading={d.loading} error={d.error} hasData={!!d.data} what="GetSchedule" actions={<Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>}>
      {d.data ? (
        <div className="flex flex-col gap-6 px-5 py-5">
          <KV items={[['Expression', <Mono key="e">{d.data.ScheduleExpression}</Mono>], ['State', <StatusPill key="s" status={d.data.State} />], ['Target', <Mono key="t">{d.data.Target?.Arn}</Mono>], ['Role', <Mono key="r">{d.data.Target?.RoleArn}</Mono>]]} />
          {d.data.Target?.Input ? <Section title="Target input"><JsonBlock value={d.data.Target.Input} maxHeight={200} /></Section> : null}
        </div>
      ) : null}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Delete schedule ${s.Name}?`} busy={m.busy} onConfirm={async () => { if (await m.run('eventbridge', 'deleteSchedule', { name: s.Name, group: s.GroupName }, 'Schedule deleted')) { setConfirm(false); onDeleted(); } }} />
    </ListCard>
  );
}

function CreateSchedule({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('rate(1 hour)');
  const [targetArn, setTargetArn] = useState('');
  const [roleArn, setRoleArn] = useState('arn:aws:iam::000000000000:role/aws-emulator-ui-role');
  const [input, setInput] = useState('');
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create schedule" description="The role must exist in the emulator and trust scheduler.amazonaws.com (npm run seed creates one)." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || !targetArn} loading={m.busy} onClick={async () => (await m.run('eventbridge', 'createSchedule', { name, expression, targetArn, roleArn, input }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Schedule expression" hint="rate(…), cron(…) or at(yyyy-mm-ddThh:mm:ss)"><Input value={expression} onChange={(e) => setExpression(e.target.value)} /></Field>
      <Field label="Target ARN"><Input value={targetArn} onChange={(e) => setTargetArn(e.target.value)} placeholder="arn:aws:sqs:…" /></Field>
      <Field label="Execution role ARN"><Input value={roleArn} onChange={(e) => setRoleArn(e.target.value)} /></Field>
      <Field label="Input (optional JSON)"><Input value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      <InlineError error={m.error} />
    </Modal>
  );
}
