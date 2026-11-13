'use client';

import { useState } from 'react';
import { useSelection } from '@/components/selection';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Checkbox, ConfirmDialog, CopyButton, Empty, Field, Input, KV, Modal, Mono, Pill, TimeAgo, formatBytes } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Repo { repositoryName: string; repositoryArn: string; repositoryUri?: string; createdAt?: string; imageTagMutability?: string }
interface Image { imageDigest: string; imageTags?: string[]; imageSizeInBytes?: number; imagePushedAt?: string; imageManifestMediaType?: string }

export default function EcrPage() {
  const repos = useAws<Repo[]>('ecr', 'list');
  const auth = useAws<{ proxyEndpoint?: string; hasToken: boolean }>('ecr', 'authToken');
  const [sel, setSel] = useSelection('repo');
  const [creating, setCreating] = useState(false);
  const selected = repos.data?.find((r) => r.repositoryName === sel) ?? null;
  return (
    <>
      <PageHeader serviceId="ecr" detail={sel ? { name: sel, onBack: () => setSel(null) } : undefined} actions={<>{auth.data ? <Pill tone={auth.data.hasToken ? 'green' : 'orange'} dot>{auth.data.hasToken ? 'Auth token available' : 'No auth token'}</Pill> : null}<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create repository</Button></>} />
      <div className="flex flex-col gap-6">
        {!sel ? (
        <ListCard title="Repositories" subtitle={repos.data ? `${repos.data.length} total` : undefined} loading={repos.loading} error={repos.error} onReload={repos.reload} hasData={!!repos.data} what="DescribeRepositories">
          <DataTable
            rows={repos.data ?? []}
            rowKey={(r) => r.repositoryName}
            onRowClick={(r) => setSel(r.repositoryName)}
            empty="No repositories yet."
            columns={[
              { key: 'n', header: 'Name', cell: (r) => <span className="font-medium text-neutral-900">{r.repositoryName}</span> },
              { key: 'm', header: 'Tags', cell: (r) => <Pill tone={r.imageTagMutability === 'IMMUTABLE' ? 'blue' : 'gray'}>{r.imageTagMutability}</Pill> },
              { key: 'c', header: 'Created', cell: (r) => <span className="text-neutral-500"><TimeAgo value={r.createdAt} /></span> },
            ]}
          />
        </ListCard>
        ) : null}
        {selected ? <RepoDetail key={selected.repositoryName} repo={selected} onDeleted={() => { setSel(null); void repos.reload(); }} /> : sel && repos.data ? <ListCard title="Images"><Empty>Not found in this region. It may have been deleted.</Empty></ListCard> : null}
      </div>
      <CreateRepo open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void repos.reload(); }} />
    </>
  );
}

function RepoDetail({ repo, onDeleted }: { repo: Repo; onDeleted: () => void }) {
  const images = useAws<Image[]>('ecr', 'images', { name: repo.repositoryName });
  const [confirm, setConfirm] = useState<Image | 'repo' | null>(null);
  const m = useMutation();
  return (
    <ListCard title={repo.repositoryName} subtitle={<Mono className="text-neutral-500">{repo.repositoryArn}</Mono>} onReload={images.reload} loading={images.loading} actions={<Button size="sm" variant="danger" onClick={() => setConfirm('repo')}><LuTrash2 /> Delete</Button>}>
      <div className="flex flex-col gap-6 px-5 py-5">
        <KV items={[['Repository URI', <span key="u" className="inline-flex items-center gap-1"><Mono>{repo.repositoryUri}</Mono>{repo.repositoryUri ? <CopyButton text={repo.repositoryUri} /> : null}</span>], ['Tag mutability', repo.imageTagMutability]]} />
        <Section title={`Images${images.data ? ` (${images.data.length})` : ''}`}>
          {images.error ? <ErrorState error={images.error} compact what="DescribeImages" /> : (
            <div className="overflow-hidden rounded-lg border border-neutral-100">
              <DataTable rows={images.data ?? []} rowKey={(i) => i.imageDigest} empty="No images. Push one with npm run ecr-push." columns={[
                { key: 't', header: 'Tags', cell: (i) => <span className="flex flex-wrap gap-1">{(i.imageTags ?? ['<untagged>']).map((t) => <Pill key={t} tone="blue">{t}</Pill>)}</span> },
                { key: 'd', header: 'Digest', cell: (i) => <span className="inline-flex items-center gap-1"><Mono>{i.imageDigest.slice(0, 19)}…</Mono><CopyButton text={i.imageDigest} /></span> },
                { key: 's', header: 'Size', align: 'right', cell: (i) => <span className="whitespace-nowrap">{formatBytes(i.imageSizeInBytes)}</span> },
                { key: 'p', header: 'Pushed', cell: (i) => <span className="text-neutral-500"><TimeAgo value={i.imagePushedAt} /></span> },
                { key: 'x', header: '', align: 'right', cell: (i) => <Button size="icon" variant="ghost" aria-label="Delete image" onClick={() => setConfirm(i)}><LuTrash2 /></Button> },
              ]} />
            </div>
          )}
        </Section>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'repo' ? `Delete ${repo.repositoryName}?` : 'Delete image?'}
        description={confirm === 'repo' ? 'Force-deletes the repository and every image in it.' : confirm ? confirm.imageDigest : undefined}
        typeToConfirm={confirm === 'repo' ? repo.repositoryName : undefined}
        busy={m.busy}
        onConfirm={async () => {
          if (confirm === 'repo') {
            if (await m.run('ecr', 'delete', { name: repo.repositoryName }, `Deleted ${repo.repositoryName}`)) { setConfirm(null); onDeleted(); }
          } else if (confirm && (await m.run('ecr', 'deleteImage', { name: repo.repositoryName, digest: confirm.imageDigest }, 'Image deleted'))) {
            setConfirm(null);
            void images.reload();
          }
        }}
      />
    </ListCard>
  );
}

function CreateRepo({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [immutable, setImmutable] = useState(false);
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create repository" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('ecr', 'create', { name, immutable }, `Created ${name}`)) && onCreated()}>Create</Button></>}>
      <Field label="Repository name" hint="e.g. team/service"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Checkbox label="Immutable tags" checked={immutable} onChange={setImmutable} />
      <InlineError error={m.error} />
    </Modal>
  );
}
