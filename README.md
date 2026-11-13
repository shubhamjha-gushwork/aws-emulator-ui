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
src/lib/catalog.ts, fidelity.json     service catalog and fidelity scores
```

Errors are normalized to `{ name, message, status, notImplemented, connection }`. Connection problems come back
as 502, and AWS errors come back as 200 with an `error` field so pages can render them inline.

## Service support (AWS Emulator v1.0.343)

All 13 services are implemented in the emulator (crates under `services/`) and work end to end in this UI.
The scores below are the emulator's own published fidelity (release v1.0.343, scored 2026-11-13). The UI shows them on each page.

| Service | Fidelity | Notes |
|---|---|---|
| Lambda | 51.3% | Invoke really runs code (nodejs20.x, python3.12) and returns the log tail. No `/aws/lambda/<fn>` log group is created. |
| SQS | 89.6% | |
| SNS | 85.2% | SQS delivery needs a queue policy, as on real AWS. The UI can add one when subscribing. |
| S3 | 84.1% | path-style addressing |
| Secrets Manager | 81.4% | |
| EventBridge / Scheduler | 86.7% / 75.2% | Scheduler roles must trust `scheduler.amazonaws.com`. |
| Step Functions | 77.9% | |
| CloudWatch Logs | 76.2% | |
| DynamoDB | 71.8% | Tables start `CREATING`. |
| ECS | 61.4% | `awsvpc` tasks need subnets. The default VPC has subnets in us-east-1a/b/c. |
| API Gateway REST (v1) | 77.6% | |
| API Gateway HTTP (v2) | 57.4% | **`ExportApi` is NotImplemented** and shows the not-supported state. |
| ELBv2 | 67.1% | IP targets must sit inside the VPC CIDR (172.31.0.0/16). |
| ECR | 87.2% | |

## Known gaps

- The emulator keeps everything in memory, so restarting it wipes all resources (just run `npm run seed` again).
- The emulator returns epoch timestamps with nanosecond precision, which the JS SDK rejects. `src/lib/compat.ts`
  trims them to milliseconds before deserializing.
- Create forms are deliberately minimal: Fargate/awsvpc task definitions, MOCK integrations for REST methods,
  HTTP listeners only, a single-file Lambda template, and uploads up to 25 MB.
- No IAM, VPC or CloudWatch Metrics pages. The UI creates one helper role, `aws-emulator-ui-role`, for
  Lambda, Step Functions, Scheduler and ECS.
