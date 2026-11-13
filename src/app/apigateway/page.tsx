'use client';

import { useState } from 'react';
import { LuFileDown, LuPlay, LuPlus, LuRocket, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, ConfirmDialog, Empty, Field, Input, JsonBlock, KV, Mono, Pill, Segmented, Select, TimeAgo } from '@/components/ui';
import { callAws, toApiError, useAws } from '@/components/use-aws';
import type { ApiError } from '@/lib/errors';
import { useMutation } from '@/components/mutate';

interface RestApi { id: string; name: string; description?: string; createdDate?: string; endpointConfiguration?: { types?: string[] } }
interface Resource { id: string; path: string; resourceMethods?: Record<string, { authorizationType?: string; methodIntegration?: { type?: string } }> }
interface Stage { stageName?: string; StageName?: string; deploymentId?: string; createdDate?: string; CreatedDate?: string; AutoDeploy?: boolean; lastUpdatedDate?: string }
interface Deployment { id: string; description?: string; createdDate?: string }
interface HttpApi { ApiId: string; Name: string; ProtocolType?: string; ApiEndpoint?: string; CreatedDate?: string; Description?: string }
interface Route { RouteId: string; RouteKey: string; Target?: string; AuthorizationType?: string }
interface Integration { IntegrationId: string; IntegrationType?: string; IntegrationUri?: string; IntegrationMethod?: string }

interface InvokeResult { status: number; headers: Record<string, string>; body: string; url: string }

/** Sends a request to a deployed stage through the emulator's data plane (`/_aws/execute-api/...`). */
function TestInvoke({ apiId, stages, defaultPath, defaultMethod = 'GET' }: { apiId: string; stages: string[]; defaultPath: string; defaultMethod?: string }) {
  const [stage, setStage] = useState('');
  const [method, setMethod] = useState(defaultMethod);
  const [path, setPath] = useState(defaultPath);
  const [body, setBody] = useState('');
  const m = useMutation();
  const [res, setRes] = useState<InvokeResult | null>(null);
  const stageValue = stage || stages[0] || '';
  if (!stages.length) return <p className="text-sm text-neutral-400">Deploy a stage first to test the API.</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Stage" className="w-36"><Select value={stageValue} onChange={(e) => setStage(e.target.value)} options={stages} /></Field>
        <Field label="Method" className="w-28"><Select value={method} onChange={(e) => setMethod(e.target.value)} options={['GET', 'POST', 'PUT', 'DELETE']} /></Field>
        <Field label="Path" className="w-56"><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/items" /></Field>
        {method !== 'GET' ? <Field label="JSON body" className="min-w-48 flex-1"><Input value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"name":"x"}' /></Field> : null}
        <Button variant="primary" loading={m.busy} data-testid="test-invoke" onClick={async () => { const r = await m.run<InvokeResult>('apigateway', 'invoke', { id: apiId, stage: stageValue, method, path, body: method !== 'GET' ? body : undefined }); if (r) setRes(r); }}><LuPlay /> Send</Button>
      </div>
      <InlineError error={m.error} />
      {res ? (
        <div className="flex flex-col gap-1.5" data-testid="invoke-result">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <Pill tone={res.status < 300 ? 'green' : res.status < 500 ? 'yellow' : 'red'} dot>HTTP {res.status}</Pill>
            <Mono className="break-all">{res.url}</Mono>
          </div>
          <JsonBlock value={res.body || '(empty body)'} maxHeight={220} />
        </div>
      ) : null}
    </div>
  );
}

const methodTone = (m: string) => (m === 'GET' ? 'green' : m === 'DELETE' ? 'red' : m === 'POST' ? 'blue' : m === 'ANY' ? 'gray' : 'yellow');

export default function ApiGatewayPage() {
  const [tab, setTab] = useState<'rest' | 'http'>('rest');
  return (
    <>
      <PageHeader serviceId="apigateway" actions={<Segmented value={tab} onChange={setTab} options={[{ value: 'rest', label: 'REST APIs (v1)' }, { value: 'http', label: 'HTTP APIs (v2)' }]} />} />
      {tab === 'rest' ? <RestTab /> : <HttpTab />}
    </>
  );
}

function CreateApiInline({ onCreate, busy }: { onCreate: (name: string) => Promise<boolean>; busy: boolean }) {
  const [name, setName] = useState('');
  return (
    <div className="flex items-center gap-2">
      <Input className="h-8 w-44" placeholder="new-api" value={name} onChange={(e) => setName(e.target.value)} />
      <Button size="sm" variant="primary" disabled={!name} loading={busy} onClick={async () => { if (await onCreate(name)) setName(''); }}><LuPlus /> Create</Button>
    </div>
  );
}

function RestTab() {
  const apis = useAws<RestApi[]>('apigateway', 'restApis');
  const [sel, setSel] = useState<string | null>(null);
  const m = useMutation();
  const selected = apis.data?.find((a) => a.id === sel) ?? null;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
      <ListCard title="REST APIs" subtitle={apis.data ? `${apis.data.length} total` : undefined} loading={apis.loading} error={apis.error} onReload={apis.reload} hasData={!!apis.data} what="GetRestApis"
        actions={<CreateApiInline busy={m.busy} onCreate={async (name) => { const r = await m.run<RestApi>('apigateway', 'createRestApi', { name }, `Created ${name}`); if (r) { setSel(r.id); void apis.reload(); } return !!r; }} />}>
        <DataTable
          rows={apis.data ?? []}
          rowKey={(a) => a.id}
          selectedKey={sel}
          onRowClick={(a) => setSel(a.id)}
          empty="No REST APIs."
          columns={[
            { key: 'n', header: 'Name', cell: (a) => <span className="font-medium text-neutral-900">{a.name}</span> },
            { key: 'i', header: 'ID', cell: (a) => <Mono>{a.id}</Mono> },
            { key: 't', header: 'Endpoint', cell: (a) => <Pill tone="gray">{a.endpointConfiguration?.types?.[0] ?? '—'}</Pill> },
            { key: 'c', header: 'Created', cell: (a) => <span className="text-neutral-500"><TimeAgo value={a.createdDate} /></span> },
          ]}
        />
      </ListCard>
      {selected ? <RestDetail key={selected.id} api={selected} onDeleted={() => { setSel(null); void apis.reload(); }} /> : <ListCard title="API details"><Empty>Select an API to see resources, methods and stages.</Empty></ListCard>}
    </div>
  );
}

function RestDetail({ api, onDeleted }: { api: RestApi; onDeleted: () => void }) {
  const resources = useAws<Resource[]>('apigateway', 'restResources', { id: api.id });
  const stages = useAws<Stage[]>('apigateway', 'restStages', { id: api.id });
  const deployments = useAws<Deployment[]>('apigateway', 'restDeployments', { id: api.id });
  const [pathPart, setPathPart] = useState('');
  const [method, setMethod] = useState('GET');
  const [stage, setStage] = useState('dev');
  const [confirm, setConfirm] = useState(false);
  const m = useMutation();
  return (
    <ListCard title={api.name} subtitle={<Mono className="text-neutral-500">{api.id}</Mono>} actions={<Button size="sm" variant="danger" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>}>
      <div className="flex flex-col gap-6 px-5 py-5">
        {api.description ? <p className="text-sm text-neutral-600">{api.description}</p> : null}
        <Section title="Resources & methods">
          {resources.error ? <ErrorState error={resources.error} compact what="GetResources" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable
                rows={[...(resources.data ?? [])].sort((a, b) => a.path.localeCompare(b.path))}
                rowKey={(r) => r.id}
                empty="No resources."
                columns={[
                  { key: 'p', header: 'Path', cell: (r) => <Mono className="text-neutral-900">{r.path}</Mono> },
                  { key: 'm', header: 'Methods', cell: (r) => <span className="flex flex-wrap gap-1">{Object.entries(r.resourceMethods ?? {}).map(([k, v]) => <Pill key={k} tone={methodTone(k)}>{k}{v.methodIntegration?.type ? ` · ${v.methodIntegration.type}` : ''}</Pill>)}{!Object.keys(r.resourceMethods ?? {}).length ? <span className="text-neutral-400">—</span> : null}</span> },
                ]}
              />
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Method" className="w-28"><Select value={method} onChange={(e) => setMethod(e.target.value)} options={['GET', 'POST', 'PUT', 'DELETE', 'ANY']} /></Field>
            <Field label="Path part (under /)" className="w-48"><Input value={pathPart} onChange={(e) => setPathPart(e.target.value)} placeholder="health" /></Field>
            <Button disabled={!pathPart} loading={m.busy} onClick={async () => { if (await m.run('apigateway', 'addMockMethod', { id: api.id, pathPart, method }, `Added ${method} /${pathPart}`)) { setPathPart(''); void resources.reload(); } }}><LuPlus /> Add MOCK method</Button>
          </div>
        </Section>
        <Section title="Stages">
          {stages.error ? <ErrorState error={stages.error} compact what="GetStages" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable rows={stages.data ?? []} rowKey={(s) => s.stageName ?? ''} empty="No stages — deploy to create one." columns={[
                { key: 'n', header: 'Stage', cell: (s) => <span className="font-medium">{s.stageName}</span> },
                { key: 'd', header: 'Deployment', cell: (s) => <Mono>{s.deploymentId}</Mono> },
                { key: 'c', header: 'Updated', cell: (s) => <span className="text-neutral-500"><TimeAgo value={s.lastUpdatedDate ?? s.createdDate} /></span> },
              ]} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <Field label="Stage name" className="w-48"><Input value={stage} onChange={(e) => setStage(e.target.value)} /></Field>
            <Button variant="primary" disabled={!stage} loading={m.busy} onClick={async () => { if (await m.run('apigateway', 'createDeployment', { id: api.id, stage }, `Deployed to ${stage}`)) { void stages.reload(); void deployments.reload(); } }}><LuRocket /> Deploy</Button>
          </div>
        </Section>
        <Section title="Test invoke">
          <TestInvoke
            apiId={api.id}
            stages={(stages.data ?? []).map((s) => s.stageName ?? '').filter(Boolean)}
            defaultPath={(resources.data ?? []).map((r) => r.path).filter((p) => p !== '/' && !p.includes('{')).sort()[0] ?? '/'}
          />
        </Section>
        <Section title={`Deployments${deployments.data ? ` (${deployments.data.length})` : ''}`}>
          {deployments.error ? <ErrorState error={deployments.error} compact what="GetDeployments" /> : (
            <div className="flex flex-col gap-1">{(deployments.data ?? []).map((d) => <div key={d.id} className="flex justify-between rounded-md border border-neutral-100 px-3 py-1.5 text-sm"><Mono>{d.id}</Mono><span className="text-neutral-500"><TimeAgo value={d.createdDate} /></span></div>)}</div>
          )}
        </Section>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${api.name}?`} description="The API, its resources, stages and deployments are deleted." typeToConfirm={api.name} busy={m.busy} onConfirm={async () => { if (await m.run('apigateway', 'deleteRestApi', { id: api.id }, `Deleted ${api.name}`)) { setConfirm(false); onDeleted(); } }} />
    </ListCard>
  );
}

function HttpTab() {
  const apis = useAws<HttpApi[]>('apigateway', 'httpApis');
  const [sel, setSel] = useState<string | null>(null);
  const m = useMutation();
  const selected = apis.data?.find((a) => a.ApiId === sel) ?? null;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
      <ListCard title="HTTP & WebSocket APIs" subtitle={apis.data ? `${apis.data.length} total` : undefined} loading={apis.loading} error={apis.error} onReload={apis.reload} hasData={!!apis.data} what="GetApis"
        actions={<CreateApiInline busy={m.busy} onCreate={async (name) => { const r = await m.run<HttpApi>('apigateway', 'createHttpApi', { name }, `Created ${name}`); if (r) { setSel(r.ApiId); void apis.reload(); } return !!r; }} />}>
        <DataTable
          rows={apis.data ?? []}
          rowKey={(a) => a.ApiId}
          selectedKey={sel}
          onRowClick={(a) => setSel(a.ApiId)}
          empty="No HTTP APIs."
          columns={[
            { key: 'n', header: 'Name', cell: (a) => <span className="font-medium text-neutral-900">{a.Name}</span> },
            { key: 'i', header: 'ID', cell: (a) => <Mono>{a.ApiId}</Mono> },
            { key: 'p', header: 'Protocol', cell: (a) => <Pill tone="blue">{a.ProtocolType}</Pill> },
          ]}
        />
      </ListCard>
      {selected ? <HttpDetail key={selected.ApiId} api={selected} onDeleted={() => { setSel(null); void apis.reload(); }} /> : <ListCard title="API details"><Empty>Select an API to see routes, integrations and stages.</Empty></ListCard>}
    </div>
  );
}

function HttpDetail({ api, onDeleted }: { api: HttpApi; onDeleted: () => void }) {
  const routes = useAws<Route[]>('apigateway', 'httpRoutes', { id: api.ApiId });
  const stages = useAws<Stage[]>('apigateway', 'httpStages', { id: api.ApiId });
  const integrations = useAws<Integration[]>('apigateway', 'httpIntegrations', { id: api.ApiId });
  const [routeKey, setRouteKey] = useState('GET /items');
  const [lambdaArn, setLambdaArn] = useState('');
  const fns = useAws<{ FunctionName: string; FunctionArn: string }[]>('lambda', 'list');
  const [stage, setStage] = useState('$default');
  const [confirm, setConfirm] = useState<Route | 'api' | null>(null);
  const [exported, setExported] = useState<{ body?: string; error?: ApiError } | null>(null);
  const [exporting, setExporting] = useState(false);
  const m = useMutation();
  const doExport = async () => {
    setExporting(true);
    try {
      setExported({ body: (await callAws<{ body: string }>('apigateway', 'exportHttpApi', { id: api.ApiId })).body });
    } catch (e) {
      setExported({ error: toApiError(e) });
    } finally {
      setExporting(false);
    }
  };
  return (
    <ListCard
      title={api.Name}
      subtitle={<Mono className="text-neutral-500">{api.ApiId}</Mono>}
      actions={
        <>
          <Button size="sm" loading={exporting} onClick={doExport} data-testid="export-openapi"><LuFileDown /> Export OpenAPI</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm('api')}><LuTrash2 /> Delete</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 px-5 py-5">
        {exported ? (
          <Section title="OpenAPI 3.0 export" actions={<Button size="sm" variant="ghost" onClick={() => setExported(null)}>Close</Button>}>
            {exported.error ? <div className="rounded-lg border border-neutral-100"><ErrorState error={exported.error} compact what="ExportApi (OpenAPI export)" /></div> : <JsonBlock value={exported.body ?? ''} maxHeight={300} />}
          </Section>
        ) : null}
        <KV items={[['Endpoint', <Mono key="e">{api.ApiEndpoint}</Mono>], ['Protocol', api.ProtocolType], ['Created', <TimeAgo key="c" value={api.CreatedDate} />], ['Description', api.Description || '—']]} />
        <Section title="Routes">
          {routes.error ? <ErrorState error={routes.error} compact what="GetRoutes" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable rows={routes.data ?? []} rowKey={(r) => r.RouteId} empty="No routes." columns={[
                { key: 'k', header: 'Route', cell: (r) => { const [meth, ...p] = r.RouteKey.split(' '); return <span className="flex items-center gap-2"><Pill tone={methodTone(meth)}>{meth}</Pill><Mono className="text-neutral-900">{p.join(' ')}</Mono></span>; } },
                { key: 't', header: 'Target', cell: (r) => <Mono>{r.Target ?? '—'}</Mono> },
                { key: 'a', header: 'Auth', cell: (r) => <Pill tone="gray">{r.AuthorizationType ?? 'NONE'}</Pill> },
                { key: 'x', header: '', align: 'right', cell: (r) => <Button size="icon" variant="ghost" aria-label="Delete route" onClick={() => setConfirm(r)}><LuTrash2 /></Button> },
              ]} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <Field label="Route key" hint="METHOD /path, e.g. POST /orders/{id}" className="w-64"><Input value={routeKey} onChange={(e) => setRouteKey(e.target.value)} /></Field>
            <Field label="Target" hint="Lambda proxy integration (payload 2.0)" className="w-64">
              <Select value={lambdaArn} onChange={(e) => setLambdaArn(e.target.value)} options={[{ value: '', label: 'No integration' }, ...(fns.data ?? []).map((f) => ({ value: f.FunctionArn, label: `λ ${f.FunctionName}` }))]} aria-label="Route target" />
            </Field>
            <Button disabled={!routeKey} loading={m.busy} onClick={async () => { if (await m.run('apigateway', 'createHttpRoute', { id: api.ApiId, routeKey, lambdaArn: lambdaArn || undefined }, `Added ${routeKey}`)) { void routes.reload(); void integrations.reload(); } }}><LuPlus /> Add route</Button>
          </div>
        </Section>
        <Section title="Integrations">
          {integrations.error ? <ErrorState error={integrations.error} compact what="GetIntegrations" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable rows={integrations.data ?? []} rowKey={(i) => i.IntegrationId} empty="No integrations." columns={[
                { key: 'i', header: 'ID', cell: (i) => <Mono>{i.IntegrationId}</Mono> },
                { key: 't', header: 'Type', cell: (i) => <Pill tone="blue">{i.IntegrationType}</Pill> },
                { key: 'u', header: 'URI', cell: (i) => <Mono className="break-all">{i.IntegrationUri}</Mono> },
              ]} />
            </div>
          )}
        </Section>
        <Section title="Stages">
          {stages.error ? <ErrorState error={stages.error} compact what="GetStages" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable rows={stages.data ?? []} rowKey={(s) => s.StageName ?? ''} empty="No stages." columns={[
                { key: 'n', header: 'Stage', cell: (s) => <span className="font-medium">{s.StageName}</span> },
                { key: 'a', header: 'Auto-deploy', cell: (s) => (s.AutoDeploy ? <Pill tone="green">on</Pill> : <Pill tone="gray">off</Pill>) },
                { key: 'c', header: 'Created', cell: (s) => <span className="text-neutral-500"><TimeAgo value={s.CreatedDate} /></span> },
              ]} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <Field label="Stage name" className="w-48"><Input value={stage} onChange={(e) => setStage(e.target.value)} /></Field>
            <Button disabled={!stage} loading={m.busy} onClick={async () => { if (await m.run('apigateway', 'createHttpStage', { id: api.ApiId, stage }, `Created stage ${stage}`)) void stages.reload(); }}><LuPlus /> Create stage</Button>
          </div>
        </Section>
        <Section title="Test invoke">
          <TestInvoke
            apiId={api.ApiId}
            stages={(stages.data ?? []).map((s) => s.StageName ?? '').filter(Boolean)}
            defaultPath={(routes.data ?? []).map((r) => r.RouteKey.split(' ')[1] ?? '').find((p) => p && !p.includes('{')) ?? '/'}
            defaultMethod={(routes.data ?? [])[0]?.RouteKey.split(' ')[0]?.replace('ANY', 'GET') ?? 'GET'}
          />
        </Section>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'api' ? `Delete ${api.Name}?` : `Delete route ${confirm ? confirm.RouteKey : ''}?`}
        typeToConfirm={confirm === 'api' ? api.Name : undefined}
        busy={m.busy}
        onConfirm={async () => {
          if (confirm === 'api') {
            if (await m.run('apigateway', 'deleteHttpApi', { id: api.ApiId }, `Deleted ${api.Name}`)) { setConfirm(null); onDeleted(); }
          } else if (confirm && (await m.run('apigateway', 'deleteHttpRoute', { id: api.ApiId, routeId: confirm.RouteId }, 'Route deleted'))) {
            setConfirm(null);
            void routes.reload();
          }
        }}
      />
    </ListCard>
  );
}
