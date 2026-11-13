/**
 * Push a local Docker image into the active backend's ECR.
 *
 *   AWS Emulator: `docker push` to its registry fails ("the operation is unsupported"),
 *   so this uploads layers through the ECR API and PutImage.
 *   Floci: a real registry — this tags and `docker push`es to the repository URI.
 *
 *   npx tsx scripts/ecr-push.ts <local-image> <repository>[:tag]     e.g. alpine:3.12 my/app:3.12
 *   REGION=ap-south-1 npx tsx scripts/ecr-push.ts …
 *
 * Uses the backend selected in the UI (or BACKEND=floci|emulator).
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  ECRClient,
  InitiateLayerUploadCommand,
  UploadLayerPartCommand,
  CompleteLayerUploadCommand,
  PutImageCommand,
  BatchCheckLayerAvailabilityCommand,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { resolveConfig } from '../src/lib/aws';
import { isFloci, loadSettings, sanitizeSettings, type BackendId } from '../src/lib/settings';

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

async function pushViaApi(ecr: ECRClient, repositoryName: string, imageTag: string, image: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ecr-push-'));
  try {
    execFileSync('docker', ['save', '-o', path.join(dir, 'image.tar'), image], { stdio: 'inherit' });
    execFileSync('tar', ['-xf', 'image.tar'], { cwd: dir });
    const [m] = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { Config: string; Layers: string[] }[];
    const config = readFileSync(path.join(dir, m.Config));
    const layers = m.Layers.map((l) => readFileSync(path.join(dir, l)));
    const upload = async (blob: Buffer) => {
      const digest = sha(blob);
      const have = await ecr.send(new BatchCheckLayerAvailabilityCommand({ repositoryName, layerDigests: [digest] }));
      if (have.layers?.[0]?.layerAvailability === 'AVAILABLE') return digest;
      const { uploadId, partSize } = await ecr.send(new InitiateLayerUploadCommand({ repositoryName }));
      const size = Math.max(partSize ?? 0, 5 * 1024 * 1024);
      for (let o = 0; o < blob.length; o += size) {
        await ecr.send(new UploadLayerPartCommand({ repositoryName, uploadId, partFirstByte: o, partLastByte: Math.min(o + size, blob.length) - 1, layerPartBlob: blob.subarray(o, o + size) }));
      }
      await ecr.send(new CompleteLayerUploadCommand({ repositoryName, uploadId, layerDigests: [digest] }));
      return digest;
    };
    const configDigest = await upload(config);
    const layerDigests: string[] = [];
    for (const l of layers) layerDigests.push(await upload(l));
    const manifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.length, digest: configDigest },
      layers: layers.map((l, i) => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar', size: l.length, digest: layerDigests[i] })),
    };
    const r = await ecr.send(new PutImageCommand({ repositoryName, imageTag, imageManifest: JSON.stringify(manifest), imageManifestMediaType: manifest.mediaType }));
    console.log(`pushed ${image} → ${repositoryName}:${imageTag} (${r.image?.imageId?.imageDigest}), ${layers.length} layer(s) via ECR API`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pushViaDocker(ecr: ECRClient, repositoryName: string, imageTag: string, image: string) {
  const desc = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
  const uri = desc.repositories?.[0]?.repositoryUri;
  if (!uri) throw new Error(`no repositoryUri for ${repositoryName}`);
  const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
  const data = auth.authorizationData?.[0];
  if (!data?.authorizationToken) throw new Error('GetAuthorizationToken returned no token');
  const decoded = Buffer.from(data.authorizationToken, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const user = sep >= 0 ? decoded.slice(0, sep) : 'AWS';
  const password = sep >= 0 ? decoded.slice(sep + 1) : decoded;
  const host = uri.split('/')[0];
  // stdin only — never print the token
  execFileSync('docker', ['login', '--username', user, '--password-stdin', host], { input: password, stdio: ['pipe', 'inherit', 'inherit'] });
  const ref = `${uri}:${imageTag}`;
  execFileSync('docker', ['tag', image, ref], { stdio: 'inherit' });
  execFileSync('docker', ['push', ref], { stdio: 'inherit' });
  console.log(`pushed ${image} → ${ref} (docker push)`);
}

async function main() {
  const [image, target] = process.argv.slice(2);
  if (!image || !target) throw new Error('usage: ecr-push.ts <local-image> <repository>[:tag]');
  const [repositoryName, imageTag = 'latest'] = target.split(':');
  const saved = await loadSettings();
  const backend = (process.env.BACKEND as BackendId | undefined);
  const settings = sanitizeSettings(
    {
      ...(backend === 'emulator' || backend === 'floci' ? { backend } : {}),
      region: process.env.REGION || saved.region,
    },
    saved,
  );
  const cfg = await resolveConfig(settings);
  const ecr = new ECRClient({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: cfg.credentials,
    requestHandler: cfg.requestHandler,
    maxAttempts: 1,
  });
  await ecr.send(new CreateRepositoryCommand({ repositoryName })).catch((e) => {
    if (e.name !== 'RepositoryAlreadyExistsException') throw e;
  });
  if (isFloci(cfg)) await pushViaDocker(ecr, repositoryName, imageTag, image);
  else await pushViaApi(ecr, repositoryName, imageTag, image);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
