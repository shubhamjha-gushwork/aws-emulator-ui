/**
 * Push a local Docker image into AWS Emulator's ECR through the ECR API (layer upload + PutImage).
 * `docker push` to the emulator's registry fails ("error from registry: the operation is unsupported"),
 * so this is the way to get a real image in.
 *
 *   npx tsx scripts/ecr-push.ts <local-image> <repository>[:tag]     e.g. alpine:3.12 my/app:3.12
 *   REGION=ap-south-1 npx tsx scripts/ecr-push.ts …                   (default us-east-1)
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ECRClient, InitiateLayerUploadCommand, UploadLayerPartCommand, CompleteLayerUploadCommand, PutImageCommand, BatchCheckLayerAvailabilityCommand, CreateRepositoryCommand } from '@aws-sdk/client-ecr';
import { resolveConfig } from '../src/lib/aws';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import { makeCtx } from '../src/lib/services/types';

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

async function main() {
  const [image, target] = process.argv.slice(2);
  if (!image || !target) throw new Error('usage: ecr-push.ts <local-image> <repository>[:tag]');
  const [repositoryName, imageTag = 'latest'] = target.split(':');
  const ctx = makeCtx(await resolveConfig({ ...DEFAULT_SETTINGS, region: process.env.REGION || 'us-east-1' }));
  const ecr = ctx.client(ECRClient);
  await ecr.send(new CreateRepositoryCommand({ repositoryName })).catch((e) => { if (e.name !== 'RepositoryAlreadyExistsException') throw e; });

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
    // docker save writes uncompressed layer tars
    const manifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.length, digest: configDigest },
      layers: layers.map((l, i) => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar', size: l.length, digest: layerDigests[i] })),
    };
    const r = await ecr.send(new PutImageCommand({ repositoryName, imageTag, imageManifest: JSON.stringify(manifest), imageManifestMediaType: manifest.mediaType }));
    console.log(`pushed ${image} → ${repositoryName}:${imageTag} (${r.image?.imageId?.imageDigest}), ${layers.length} layer(s)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
