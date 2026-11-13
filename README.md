# AWS Emulator UI

A local web console for [Amazon's AWS Emulator](https://github.com/aws/aws-emulator)
([docs](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html)), styled with the
Gushwork UI design system (Tailwind v4 tokens, Inter + VertGrotesk, `#0070FF` accent, light mode).

It covers **13 services**: Lambda, SQS, SNS, S3, Secrets Manager, EventBridge (+ Scheduler), Step Functions,
CloudWatch Logs, DynamoDB, ECS, API Gateway (REST v1 + HTTP v2), Elastic Load Balancing v2 and ECR.
Each service page lists resources, shows details and supports basic create / delete (with confirm dialogs)
plus the everyday actions (invoke, send/receive, publish, upload/download, put events, start execution,
tail logs, scan, run task, scale, export, register target, …).

If the emulator answers `NotImplemented` for something, the UI shows an orange
**"Not supported by AWS Emulator yet"** state. It never fakes data.

## Startup guide (macOS)

### 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker Desktop (or OrbStack / colima), **running** | any recent | `docker info` |
| Node.js + npm | Node 20+ (tested on 24) | `node -v` |
| git | any | `git --version` |
| AWS CLI v2 (optional, to poke the emulator from a terminal) | 2.x | `aws --version` |

About 1 GB free disk for the image, and 2 GB RAM for the container.

### 2. Clone and start

```bash
git clone git@github.com:shubhamjha-gushwork/aws-emulator-ui.git
cd aws-emulator-ui
scripts/start-local.sh --seed
```

`start-local.sh` does the following and is safe to rerun:

1. Builds the `aws-emulator` Docker image from `docker/Dockerfile` the first time (~2 min). It uses the Apple-silicon or Intel package automatically.
2. Starts the container `aws-emulator` on **https://127.0.0.1:9297**. It's localhost only, capped at 2 GB and has telemetry off.
3. Runs `npm install` and `npm run build` if needed, then starts the UI in the background on **http://127.0.0.1:3297**.
4. `--seed` creates `demo-*` resources in all 13 services. Use `--rebuild` to rebuild the emulator image (for example, to pick up a new emulator release).

Then open **http://127.0.0.1:3297**. The header pill should say **Connected**.

### 3. Stop

```bash
scripts/stop-local.sh            # stop the UI and the emulator container
scripts/stop-local.sh --ui-only  # stop only the UI and keep the emulator (and its data) running
```

> **Data is in memory only.** Stopping or restarting the emulator, quitting Docker Desktop or rebooting wipes
> every resource. Run `scripts/start-local.sh --seed` to get the demo data back.

### 4. Use the AWS CLI / SDKs against the emulator

Each time the emulator starts it writes a fresh config (endpoint, region, CA bundle) and SigV4 keys to `~/.aws/emulator/9297/`.
Point the CLI at them:

```bash
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export AWS_CONFIG_FILE=~/.aws/emulator/9297/config
export AWS_SHARED_CREDENTIALS_FILE=~/.aws/emulator/9297/emulator_credentials

aws sts get-caller-identity   # → "Account": "000000000000", ".../user/emulator"
aws sqs list-queues
```

Switch back to real AWS:

```bash
unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE
aws sts get-caller-identity   # → your real account
```

Optional aliases for `~/.zshrc`:

```bash
alias aws-local='unset AWS_PROFILE; export AWS_CONFIG_FILE=~/.aws/emulator/9297/config AWS_SHARED_CREDENTIALS_FILE=~/.aws/emulator/9297/emulator_credentials; aws sts get-caller-identity'
alias aws-real='unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE; aws sts get-caller-identity'
```

Always run `aws sts get-caller-identity` before anything destructive. The emulator account is `000000000000`.
SDKs read the same two variables. See [Pointing your AWS SDK at AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/point-sdk-to-emulator.html).

### 5. Linux

Install the `.rpm` or `.deb` from the [releases page](https://github.com/aws/aws-emulator/releases) (or follow
[Getting started on Linux](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-linux.html)), then run:

```bash
scripts/start-local.sh --seed   # uses the installed `aws-emulator` binary; USE_DOCKER=1 forces Docker
# or by hand:
aws-emulator -t off
```

### 6. Manual Docker commands (what the script runs)

```bash
docker build --build-arg EMULATOR_ARCH=aarch64 -t aws-emulator docker   # x86_64 on Intel
mkdir -p ~/.aws/emulator
docker run -d --rm --name aws-emulator --memory=2g --memory-swap=2g \
  -p 127.0.0.1:9297:9297 \
  -e HOME="$HOME" -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \
  aws-emulator -p 9297 --telemetry off

npm install && npm run build
npm start                     # UI on http://127.0.0.1:3297
docker stop aws-emulator      # stop (the container is removed because of --rm)
```

Always publish the port as `127.0.0.1:9297:9297`. A bare `9297:9297` exposes the emulator to your whole network.

### 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker is installed but not running` / `Cannot connect to the Docker daemon` | Start Docker Desktop and wait for it to say it's running, then rerun `scripts/start-local.sh`. |
| `port is already allocated` or `address already in use` on 9297 / 3297 | Run `lsof -nP -iTCP:9297 -sTCP:LISTEN` (or `:3297`) to see who holds it. If it's an old UI, run `scripts/stop-local.sh --ui-only`. If it's an old container, run `docker rm -f aws-emulator`. Or pick other ports with `AWS_EMULATOR_PORT` / `UI_PORT`. |
| UI shows **Disconnected**, or the CLI fails with `InvalidClientTokenId` / `SignatureDoesNotMatch` / certificate errors after an emulator restart | Every run makes new keys and a new CA. The UI's Auto mode picks them up on the next request (check **Settings → Credentials = Auto**). For the CLI, re-export the two variables in your current shell (or run `aws-local`) and make sure `AWS_PROFILE` and `AWS_ACCESS_KEY_ID` are unset. |
| `SSL: CERTIFICATE_VERIFY_FAILED` from other tools | Point them at `~/.aws/emulator/9297/ca.pem` (the CLI does this through `ca_bundle` in the config file). |
| Container exits with code 137 | It ran out of its 2 GB of memory. Restart it. Raise `--memory` if you need more. |
| Resources disappeared | The emulator restarted, and its state is in memory only. Run `scripts/start-local.sh --seed`. |
| Logs | Emulator: `docker logs -f aws-emulator`. UI: `~/Library/Logs/aws-emulator-ui/ui.log` on macOS (`.data/logs/ui.log` on Linux). |

## Requirements

- Node.js 20+
- AWS Emulator ≥ 1.0.343, from the `.deb`/`.rpm`/`.pkg` on the
  [releases page](https://github.com/aws/aws-emulator/releases) or the Docker image.

## Run

```bash
# 1. start the emulator (HTTPS on 127.0.0.1:9297, auth on, telemetry off)
aws-emulator -t off

# 2. start the UI
npm install
npm run build && npm start      # or: npm run dev
open http://127.0.0.1:3297
```

The UI only listens on `127.0.0.1:3297`. All AWS calls happen server-side with AWS SDK v3, so credentials
never reach the browser.

### One-command start/stop (macOS, Linux)

```bash
scripts/start-local.sh            # start the emulator + UI (add --seed for demo data, --rebuild to rebuild the image)
scripts/stop-local.sh             # stop the UI and the emulator (this wipes emulator state)
scripts/stop-local.sh --ui-only   # stop only the UI
```

- **macOS / Windows:** the emulator runs in Docker, following the official
  [Getting started with Docker](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html) guide.
  The image comes from `docker/Dockerfile` and is built on first run (Arm or x86 package picked automatically).
  The container is named `aws-emulator`, publishes `127.0.0.1:9297` only, and is capped at 2 GiB of memory.
  It runs with `-e HOME=$HOME -v ~/.aws/emulator:~/.aws/emulator`, so its per-run keys and CA land in
  `~/.aws/emulator/9297/` on your machine. That's where the UI's **Auto** credentials mode looks, so no extra setup is needed.
  You need Docker Desktop (or another Docker runtime) running.
- **Linux:** uses the installed `aws-emulator` binary if there is one (`USE_DOCKER=1` forces Docker).
- The UI runs in the background on `127.0.0.1:3297` (`npm install`/`npm run build` happen first if needed).
  Logs go to `~/Library/Logs/aws-emulator-ui/ui.log` on macOS and `.data/logs/` elsewhere.
  Emulator logs: `docker logs aws-emulator`.
- Overrides: `AWS_EMULATOR_PORT`, `UI_PORT`, `AWS_EMULATOR_CONTAINER`, `AWS_EMULATOR_IMAGE`, `LOG_DIR`.
- Nothing starts automatically at login.

### Credentials and TLS

The emulator runs with `--auth on` by default and writes fresh SigV4 keys and a CA certificate on each start, to
`~/.aws/emulator/<port>/{emulator_credentials,ca.pem,config}`. In **Auto** mode (the default) the UI reads
those files on every request, so restarting the emulator just works. In **Manual** mode you enter the keys
yourself (for example when running with `--auth off` or in Docker). If the run files are missing, Auto mode falls back to dummy keys.

You can change the endpoint, region, credentials mode and TLS verification at **Settings**. They're saved to
`.data/settings.json` (mode 600, git-ignored) and the secret is never sent back to the browser. Environment overrides:

| Variable | Purpose |
|---|---|
| `AWS_EMULATOR_ENDPOINT` | default endpoint (e.g. `https://127.0.0.1:9297`) |
| `AWS_EMULATOR_REGION` | default region |
| `AWS_EMULATOR_HOME` | emulator run-files directory (default `~/.aws/emulator`) |
| `AWS_EMULATOR_UI_DATA_DIR` | where settings are stored (default `.data`) |

## Scripts

| Command | What it does |
|---|---|
| `npm run seed` | Idempotently creates `demo-*` resources in all 13 services (functions, queues, topics with a working SNS→SQS subscription, buckets/objects, secrets, rules/schedules, a state machine plus an execution, tables/items, an ECS cluster/service/task, an ALB plus a target group, REST and HTTP APIs, ECR repos with an image). |
| `npm run smoke` | Drives every service through the UI's own HTTP API with `smoke-*` resources and cleans them up. Results are written to `.data/smoke-results.json`. |
| `npm test` | Vitest: unit tests, plus live emulator tests that are skipped when the emulator isn't running. |
| `npm run shots` | Playwright screenshots of every page into `../aws-emulator-ui-shots` (`SHOTS_DIR` overrides). Fails on console errors or error banners. Needs `npm run seed` first and the UI running. |
| `npm run typecheck` / `npm run lint` / `npm run build` | The usual checks. |

## Architecture

```
src/app/<service>/page.tsx            client pages (Gushwork components in src/components)
src/app/api/aws/[service]/[action]    one generic POST route → service registry
src/lib/services/*.ts                 one module per service: named actions on AWS SDK v3 clients
src/lib/aws.ts                        endpoint, credentials, CA and health check
src/lib/compat.ts                     SDK compatibility middleware (see below)
src/lib/catalog.ts                    service catalog
```

Errors are normalized to `{ name, message, status, notImplemented, connection }`. Connection problems come back
as 502, and AWS errors come back as 200 with an `error` field so pages can render them inline.

## Service support (AWS Emulator v1.0.343)

All 13 services are implemented in the emulator (crates under `services/`) and work end to end in this UI.

| Service | Notes |
|---|---|
| Lambda | Invoke really runs code (nodejs20.x, python3.12) and returns the log tail. No `/aws/lambda/<fn>` log group is created. |
| SQS | |
| SNS | SQS delivery needs a queue policy, as on real AWS. The UI can add one when subscribing. |
| S3 | path-style addressing |
| Secrets Manager | |
| EventBridge / Scheduler | Scheduler roles must trust `scheduler.amazonaws.com`. |
| Step Functions | |
| CloudWatch Logs | |
| DynamoDB | Tables start `CREATING`. |
| ECS | `awsvpc` tasks need subnets. The default VPC has subnets in us-east-1a/b/c. |
| API Gateway REST (v1) | |
| API Gateway HTTP (v2) | **`ExportApi` is NotImplemented** and shows the not-supported state. |
| ELBv2 | IP targets must sit inside the VPC CIDR (172.31.0.0/16). |
| ECR | |

## Known gaps

- The emulator keeps everything in memory, so restarting it wipes all resources (just run `npm run seed` again).
- The emulator returns epoch timestamps with nanosecond precision, which the JS SDK rejects. `src/lib/compat.ts`
  trims them to milliseconds before deserializing.
- Create forms are deliberately minimal: Fargate/awsvpc task definitions, MOCK integrations for REST methods,
  HTTP listeners only, a single-file Lambda template, and uploads up to 25 MB.
- No IAM, VPC or CloudWatch Metrics pages. The UI creates one helper role, `aws-emulator-ui-role`, for
  Lambda, Step Functions, Scheduler and ECS.
