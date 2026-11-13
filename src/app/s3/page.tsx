'use client';

import { useRef, useState } from 'react';
import { LuDownload, LuFile, LuFolder, LuPlus, LuTrash2, LuUpload } from 'react-icons/lu';
import { ListCard } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, Checkbox, ConfirmDialog, Empty, Field, Input, Modal, TimeAgo, formatBytes } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Bucket { Name: string; CreationDate?: string }
interface Obj { Key: string; Size?: number; LastModified?: string; StorageClass?: string; ETag?: string }
interface Listing { prefixes: string[]; objects: Obj[]; truncated?: boolean }

export default function S3Page() {
  const list = useAws<Bucket[]>('s3', 'list');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader serviceId="s3" actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create bucket</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
        <ListCard title="Buckets" subtitle={list.data ? `${list.data.length} total` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListBuckets">
          <DataTable
            rows={list.data ?? []}
            rowKey={(b) => b.Name}
            selectedKey={sel}
            onRowClick={(b) => setSel(b.Name)}
            empty="No buckets yet."
            columns={[
              { key: 'n', header: 'Name', cell: (b) => <span className="font-medium text-neutral-900">{b.Name}</span> },
              { key: 'c', header: 'Created', cell: (b) => <span className="text-neutral-500"><TimeAgo value={b.CreationDate} /></span> },
            ]}
          />
        </ListCard>
        {sel ? <BucketBrowser key={sel} bucket={sel} onDeleted={() => { setSel(null); void list.reload(); }} /> : (
          <ListCard title="Objects"><Empty>Select a bucket to browse, upload and download objects.</Empty></ListCard>
        )}
      </div>
      <CreateBucket open={creating} onClose={() => setCreating(false)} onCreated={(b) => { setCreating(false); setSel(b); void list.reload(); }} />
    </>
  );
}

function BucketBrowser({ bucket, onDeleted }: { bucket: string; onDeleted: () => void }) {
  const [prefix, setPrefix] = useState('');
  const listing = useAws<Listing>('s3', 'listObjects', { bucket, prefix });
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirm, setConfirm] = useState<Obj | 'bucket' | null>(null);
  const [emptyFirst, setEmptyFirst] = useState(true);
  const up = useMutation();
  const m = useMutation();
  const crumbs = prefix.split('/').filter(Boolean);

  type Row = { kind: 'dir'; key: string } | ({ kind: 'obj' } & Obj);
  const rows: Row[] = [
    ...(listing.data?.prefixes ?? []).map((p) => ({ kind: 'dir' as const, key: p })),
    ...(listing.data?.objects ?? []).filter((o) => o.Key !== prefix).map((o) => ({ kind: 'obj' as const, ...o })),
  ];

  const upload = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await up.run('s3', 'putObject', { bucket, key: prefix + f.name, base64: btoa(bin), contentType: f.type || 'application/octet-stream' }, `Uploaded ${f.name}`);
    }
    if (fileRef.current) fileRef.current.value = '';
    void listing.reload();
  };

  return (
    <ListCard
      title={bucket}
      subtitle={
        <span className="flex flex-wrap items-center gap-1">
          <button className="cursor-pointer text-primary hover:underline" onClick={() => setPrefix('')}>{bucket}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              /<button className="cursor-pointer text-primary hover:underline" onClick={() => setPrefix(crumbs.slice(0, i + 1).join('/') + '/')}>{c}</button>
            </span>
          ))}
        </span>
      }
      loading={listing.loading}
      error={listing.error}
      onReload={listing.reload}
      hasData={!!listing.data}
      what="ListObjectsV2"
      actions={
        <>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} data-testid="s3-file-input" />
          <Button size="sm" variant="primary" loading={up.busy} onClick={() => fileRef.current?.click()}><LuUpload /> Upload</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm('bucket')}><LuTrash2 /> Delete bucket</Button>
        </>
      }
    >
      <DataTable
        rows={rows}
        rowKey={(r) => r.kind + (r.kind === 'dir' ? r.key : r.Key)}
        empty="This folder is empty. Upload a file to get started."
        onRowClick={(r) => r.kind === 'dir' && setPrefix(r.key)}
        columns={[
          {
            key: 'k', header: 'Name', cell: (r) => r.kind === 'dir'
              ? <span className="inline-flex items-center gap-2 font-medium text-neutral-900"><LuFolder className="h-4 w-4 text-primary-500" />{r.key.slice(prefix.length)}</span>
              : <span className="inline-flex items-center gap-2 text-neutral-900"><LuFile className="h-4 w-4 text-neutral-400" />{r.Key.slice(prefix.length)}</span>,
          },
          { key: 's', header: 'Size', align: 'right', cell: (r) => (r.kind === 'obj' ? formatBytes(r.Size) : '') },
          { key: 'm', header: 'Modified', cell: (r) => (r.kind === 'obj' ? <span className="text-neutral-500"><TimeAgo value={r.LastModified} /></span> : '') },
          {
            key: 'a', header: '', align: 'right', cell: (r) => r.kind === 'obj' ? (
              <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
                <a href={`/api/s3/download?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(r.Key)}`} className="inline-flex size-8 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900" aria-label="Download" title="Download">
                  <LuDownload className="h-4 w-4" />
                </a>
                <Button size="icon" variant="ghost" aria-label="Delete object" onClick={() => setConfirm(r)}><LuTrash2 /></Button>
              </span>
            ) : null,
          },
        ]}
      />
      {listing.data?.truncated ? <div className="border-t border-neutral-100 px-5 py-2 text-xs text-neutral-500">Showing the first 500 keys.</div> : null}
      <div className="px-5 pb-3"><InlineError error={up.error} /></div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'bucket' ? `Delete bucket ${bucket}?` : `Delete ${confirm ? confirm.Key : ''}?`}
        description={confirm === 'bucket' ? 'S3 only deletes empty buckets.' : 'The object is deleted permanently.'}
        typeToConfirm={confirm === 'bucket' ? bucket : undefined}
        busy={m.busy}
        onConfirm={async () => {
          if (confirm === 'bucket') {
            if (emptyFirst && !(await m.run('s3', 'emptyBucket', { bucket }))) return;
            if (await m.run('s3', 'deleteBucket', { bucket }, `Deleted ${bucket}`)) { setConfirm(null); onDeleted(); }
          } else if (confirm && (await m.run('s3', 'deleteObject', { bucket, key: confirm.Key }, 'Object deleted'))) {
            setConfirm(null);
            void listing.reload();
          }
        }}
      >
        {confirm === 'bucket' ? <Checkbox label="Delete all objects first" checked={emptyFirst} onChange={setEmptyFirst} /> : null}
      </ConfirmDialog>
    </ListCard>
  );
}

function CreateBucket({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (b: string) => void }) {
  const [name, setName] = useState('');
  const m = useMutation();
  return (
    <Modal open={open} onClose={onClose} title="Create bucket" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={m.busy} onClick={async () => (await m.run('s3', 'createBucket', { bucket: name }, `Created ${name}`)) && onCreated(name)}>Create</Button></>}>
      <Field label="Bucket name" hint="3–63 lowercase letters, numbers, dots and hyphens"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <InlineError error={m.error} />
    </Modal>
  );
}
