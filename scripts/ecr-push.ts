/**
 * Push a local Docker image into Floci's ECR with docker login / docker push.
 *
 *   npx tsx scripts/ecr-push.ts <local-image> <repository>[:tag]     e.g. alpine:3.12 my/app:3.12
 *   REGION=ap-south-1 npx tsx scripts/ecr-push.ts …
 */
import { execFileSync } from 'child_process';
import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { resolveConfig } from '../src/lib/aws';
import { loadSettings, sanitizeSettings } from '../src/lib/settings';

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
  const settings = sanitizeSettings({ region: process.env.REGION || saved.region }, saved);
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
  await pushViaDocker(ecr, repositoryName, imageTag, image);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
