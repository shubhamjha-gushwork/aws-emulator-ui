# AWS Emulator

A local web console for [Amazon's AWS Emulator](https://github.com/aws/aws-emulator)
([docs](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html)) and
[Floci](https://github.com/floci-io/floci), styled with the
Gushwork UI design system (Tailwind v4 tokens, Inter + VertGrotesk, `#0070FF` accent, light mode).
Switch backends in **Settings**. AWS Emulator is the default.

It covers **13 services**: Lambda, SQS, SNS, S3, Secrets Manager, EventBridge (+ Scheduler), Step Functions,
CloudWatch Logs, DynamoDB, ECS, API Gateway (REST v1 + HTTP v2), Elastic Load Balancing v2 and ECR.
Each service page lists resources, shows details and supports basic create / delete (with confirm dialogs)
plus the everyday actions (invoke, send/receive, publish, upload/download, put events, start execution,
tail logs, DynamoDB scan, run task, scale, export, register target, …).

If the emulator answers `NotImplemented` for something, the UI shows an orange
**"Not supported by AWS Emulator yet"** state. It never fakes data.

## Screenshots

**Overview:** backend health, resource counts per service, and the current region.

![Overview](docs/screenshots/overview.webp)

**Region menu:** pick the region in the top bar, as in the AWS console. Every page follows it.

![Region menu](docs/screenshots/region-menu.webp)

**CloudWatch Logs:** all log groups, filtered by source (Lambda, ECS, Other) or by prefix.

![Log groups](docs/screenshots/logs-groups.webp)

**Log group:** one page to filter, pick a stream and time range, and follow new events live.

![Log group](docs/screenshots/log-group.webp)

**ECS cluster:** services and tasks of a cluster, with launch, scale and delete.

![ECS cluster](docs/screenshots/ecs-cluster.webp)

**Step Functions:** the state machine's steps, its executions, and the event history of a run.

![Step Functions](docs/screenshots/step-functions.webp)

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
# also start Floci (http://127.0.0.1:4566) alongside the emulator:
# scripts/start-local.sh --floci --seed
```

`start-local.sh` does the following and is safe to rerun:

1. Builds the `aws-emulator` Docker image from `docker/Dockerfile` the first time (~2 min). It uses the Apple-silicon or Intel package automatically.
2. Starts the container `aws-emulator` on **https://127.0.0.1:9297**. It's localhost only, capped at 2 GB and has telemetry off. This is the default backend; add `--floci` or `--backend both` to also start Floci, or `--backend floci` to start only Floci (a running AWS Emulator is left alone).
3. Runs `npm install` and `npm run build` if needed, then starts the UI in the background on **http://127.0.0.1:3297**.
4. `--seed` creates `demo-*` resources in all 13 services on whichever backend the UI is currently set to. Use `--rebuild` to rebuild the emulator image (for example, to pick up a new emulator release).

Then open **http://127.0.0.1:3297**. The header pill should say **Connected**, and the top bar shows the active backend. Switch to Floci in **Settings** after starting it.

### 3. Stop

```bash
scripts/stop-local.sh            # stop the UI and the AWS Emulator container (Floci is left running)
scripts/stop-local.sh --ui-only  # stop only the UI and keep the backends (and their data) running
scripts/stop-local.sh --floci    # also stop the Floci container
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

### 5. Point the AWS CLI at Floci

Floci is plain HTTP and accepts any non-empty keys (commonly `test` / `test`). It does not write files under `~/.aws/emulator/`.

```bash
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_EC2_METADATA_DISABLED=true
# optional, so a real profile cannot leak in:
# unset AWS_PROFILE
# export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null

aws s3 ls
aws ecs list-clusters
```

`unset AWS_ENDPOINT_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY` (and the others) to go back to real AWS, or to the AWS Emulator files in section 4.

### 6. Linux

Install the `.rpm` or `.deb` from the [releases page](https://github.com/aws/aws-emulator/releases) (or follow
[Getting started on Linux](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-linux.html)), then run:

```bash
scripts/start-local.sh --seed   # uses the installed `aws-emulator` binary; USE_DOCKER=1 forces Docker
# or by hand:
aws-emulator -t off
```

### 7. Manual Docker commands (what the script runs)

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

### 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker is installed but not running` / `Cannot connect to the Docker daemon` | Start Docker Desktop and wait for it to say it's running, then rerun `scripts/start-local.sh`. |
| `port is already allocated` or `address already in use` on 9297 / 3297 | Run `lsof -nP -iTCP:9297 -sTCP:LISTEN` (or `:3297`) to see who holds it. If it's an old UI, run `scripts/stop-local.sh --ui-only`. If it's an old container, run `docker rm -f aws-emulator`. Or pick other ports with `AWS_EMULATOR_PORT` / `UI_PORT`. |
| UI shows **Disconnected**, or the CLI fails with `InvalidClientTokenId` / `SignatureDoesNotMatch` / certificate errors after an emulator restart | Every run makes new keys and a new CA. The UI picks them up on the next request. For the CLI, re-export the two variables in your current shell (or run `aws-local`) and make sure `AWS_PROFILE` and `AWS_ACCESS_KEY_ID` are unset. |
| ECS RunTask / CreateService fail with `this emulator holds at most 512 tasks` | Stopped tasks count toward the emulator's limit. Delete the cluster that has many stopped tasks (see **Tasks → Stopped**) and re-run `npm run seed`, or restart the emulator. Scale services to 0 when you're done. |
| ECS tasks stop with `CannotPullContainerError` | Run them from the UI (it adds an internet route to the default VPC and a public IP), and use the helper role or one with ECR pull permissions for images in this account's ECR. |
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
scripts/start-local.sh                 # start AWS Emulator + UI (add --seed for demo data, --rebuild to rebuild the image)
scripts/start-local.sh --floci         # also start Floci on http://127.0.0.1:4566
scripts/start-local.sh --backend floci # start only Floci + UI
scripts/stop-local.sh                  # stop the UI and AWS Emulator (this wipes emulator state; Floci stays up)
scripts/stop-local.sh --ui-only        # stop only the UI
scripts/stop-local.sh --floci          # also stop Floci (this wipes Floci state)
```

- **macOS / Windows:** the emulator runs in Docker, following the official
  [Getting started with Docker](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html) guide.
  The image comes from `docker/Dockerfile` and is built on first run (Arm or x86 package picked automatically).
  The container is named `aws-emulator`, publishes `127.0.0.1:9297` only, and is capped at 2 GiB of memory.
  It runs with `-e HOME=$HOME -v ~/.aws/emulator:~/.aws/emulator`, so its per-run keys and CA land in
  `~/.aws/emulator/9297/` on your machine. The UI reads its credentials from there automatically, so no extra setup is needed.
  You need Docker Desktop (or another Docker runtime) running.
- **Linux:** uses the installed `aws-emulator` binary if there is one (`USE_DOCKER=1` forces Docker).
- The UI runs in the background on `127.0.0.1:3297` (`npm install`/`npm run build` happen first if needed).
  Logs go to `~/Library/Logs/aws-emulator-ui/ui.log` on macOS and `.data/logs/` elsewhere.
  Emulator logs: `docker logs aws-emulator`.
- Overrides: `AWS_EMULATOR_PORT`, `UI_PORT`, `AWS_EMULATOR_CONTAINER`, `AWS_EMULATOR_IMAGE`, `LOG_DIR`, `FLOCI_PORT` (default 4566), `FLOCI_CONTAINER`, `FLOCI_IMAGE`, `FLOCI_NETWORK` (default `floci-net`).
- **Floci** runs as `floci/floci:latest` on a user-defined Docker network (`floci-net`) with the host Docker socket mounted, 2 GB memory, and ECS task ports published on localhost so you can curl a container. A user-defined network is required for `docker push` to Floci ECR (Docker's default `bridge` cannot resolve the registry sidecar by name).
- Nothing starts automatically at login.

### Credentials, region and TLS

The emulator runs with `--auth on` by default and writes fresh SigV4 keys and a CA certificate on each start, to
`~/.aws/emulator/<port>/{emulator_credentials,ca.pem,config}`. The UI reads those files on every request, so
restarting the emulator just works; there is nothing to enter. If the run files are missing it falls back to
dummy keys (fine for `--auth off`).

**Region:** pick it from the region menu in the top bar, as in the AWS console. It lists Asia Pacific (Mumbai)
`ap-south-1`, Asia Pacific (Singapore) `ap-southeast-1`, US East (N. Virginia) `us-east-1`, US East (Ohio)
`us-east-2`, US West (Oregon) `us-west-2`, Europe (Ireland) `eu-west-1` and Europe (Frankfurt) `eu-central-1`
(edit `src/lib/regions.ts` to change the list). Choosing one saves it and reloads every page's data. That menu is the only place to change the region.
**Settings** is a switch between **AWS Emulator** (`https://127.0.0.1:9297`, the emulator's per-run keys and CA) and **Floci** (`http://127.0.0.1:4566`, dummy `test`/`test` keys, TLS off). Credentials are never shown or stored. The chosen backend, its endpoint and TLS flag, and the region are saved to `.data/settings.json` (mode 600, git-ignored). The top bar shows the active backend. Environment overrides:

| Variable | Purpose |
|---|---|
| `AWS_EMULATOR_ENDPOINT` | default endpoint (e.g. `https://127.0.0.1:9297`) |
| `AWS_EMULATOR_REGION` | default region |
| `AWS_EMULATOR_HOME` | emulator run-files directory (default `~/.aws/emulator`) |
| `AWS_EMULATOR_UI_DATA_DIR` | where settings are stored (default `.data`) |
| `FLOCI_ENDPOINT` / `FLOCI_PORT` | Floci endpoint (default `http://127.0.0.1:4566`) |

## Scripts

| Command | What it does |
|---|---|
| `npm run seed` | Idempotently creates `demo-*` resources in all 13 services (functions, queues, topics with a working SNS→SQS subscription, buckets/objects, secrets, rules/schedules, a state machine plus an execution, tables/items, an ECS cluster/service/task, an ALB plus a target group, REST and HTTP APIs, ECR repos with an image). |
| `npm run smoke` | User test of every service through the UI's own HTTP API, against the backend selected in Settings (or `BACKEND=floci` / `BACKEND=emulator` to switch temporarily and restore afterwards). In the region selected in the UI, with `uitest-*` resources that it deletes afterwards (demo data is untouched): Lambda create/invoke/logs, SQS, SNS→SQS delivery, S3, Secrets, EventBridge rule→SQS delivery, Scheduler, Step Functions, Logs, DynamoDB, ECS task definition→run task→container output in CloudWatch→service (a real `nginx:alpine` image on Floci), API Gateway REST (MOCK) and HTTP (→Lambda) invokes, ELB, ECR. Results go to `.data/smoke-results.json`. |
| `npm run sfn-deep` | Step Functions deep test: Pass, Task (`lambda:invoke` and direct ARN), Choice, Wait, Parallel, Map, Succeed, Fail, Retry+Catch, SQS/SNS/DynamoDB integrations, history, stop, update, delete, EXPRESS sync runs. Results go to `.data/sfn-deep-<region>.json`. |
| `npm run ecr-push -- <image> <repo>:<tag>` | Pushes a local Docker image to the active backend's ECR. AWS Emulator has no working `docker push` (the script uses the ECR layer APIs). Floci is a real registry, so the script runs `docker login` and `docker push` to the repository URI. `BACKEND=floci` overrides the UI setting. |
| `npm run logs-probe` | Evidence of what writes to CloudWatch Logs on its own (Lambda with and without log permissions, ECS awslogs). |
| `npm test` | Vitest: unit tests, plus live emulator tests that are skipped when the emulator isn't running. |
| `npm run shots` | Playwright screenshots of every page into `../aws-emulator-ui-shots` (`SHOTS_DIR` overrides). Fails on console errors or error banners. Needs `npm run seed` first and the UI running. |
| `npm run typecheck` / `npm run lint` / `npm run build` | The usual checks. |

### Navigation

Every service works like the AWS console: a full-width list, and a row opens that resource on a full page with a
breadcrumb back to the list (`Services › ECS › demo-cluster`). The selection is kept in the URL, so the
browser's back button and reloads work.

## Architecture

```
src/app/<service>/page.tsx            client pages (Gushwork components in src/components)
src/app/api/aws/[service]/[action]    one generic POST route → service registry
src/lib/services/*.ts                 one module per service: named actions on AWS SDK v3 clients
src/lib/aws.ts                        backend, endpoint, credentials, CA and health check
src/lib/backends.ts                   AWS Emulator and Floci presets (endpoints, health paths)
src/lib/regions.ts                    the regions offered in the region menu
src/lib/services/iam-role.ts          the helper role the UI uses when you don't pass one
src/lib/compat.ts                     SDK compatibility middleware (see below)
src/lib/catalog.ts                    service catalog
```

Errors are normalized to `{ name, message, status, notImplemented, connection }`. Connection problems come back
as 502, and AWS errors come back as 200 with an `error` field so pages can render them inline.

## Service support

All 13 services work end to end against both backends. Notes below that mention AWS Emulator limits apply only when that backend is selected.

| Service | Notes |
|---|---|
| Lambda | Invoke really runs code (nodejs20.x, python3.12) and returns the log tail. Creating a function waits until it's Active. |
| SQS | |
| SNS | SQS delivery needs a queue policy, as on real AWS. The UI can add one when subscribing. |
| S3 | path-style addressing; buckets are global, so they show in every region |
| Secrets Manager | |
| EventBridge / Scheduler | SQS targets need a queue policy for `events.amazonaws.com`; the UI adds it when you add the target. |
| Step Functions | All state types and the Lambda, SQS, SNS and DynamoDB integrations work. `sns:publish` with a JSON object as `Message` fails (`States.Runtime: … 'Message' is a structure, which this emulator does not bind …`); pass a string, e.g. `"Message.$": "States.JsonToString($)"`. EXPRESS machines run synchronously from the UI (their executions aren't listed, as on AWS). |
| CloudWatch Logs | **Logs** is a table of log groups (All / Lambda / ECS / Other, prefix search, streams, size, last event). Lambda = `/aws/lambda/*`; ECS = `/ecs/*`, `/aws/ecs/*` and any `awslogs-group` used by a task definition in this region. A group opens on its own page (`/logs/<group>`) with one event view: filter pattern, stream picker, time range (15m / 1h / 24h / All), **Follow** for live tailing, and **Test event** to write one line. |
| DynamoDB | Tables start `CREATING`. |
| ECS | See [ECS on AWS Emulator](#ecs-on-aws-emulator). |
| API Gateway REST (v1) | MOCK methods get a 200 method/integration response. Use **Test invoke** on an API to call it through the emulator's data plane (`/_aws/execute-api/{id}/{stage}/{path}`). |
| API Gateway HTTP (v2) | Routes can target a Lambda (AWS_PROXY, payload 2.0). **`ExportApi` is NotImplemented** and shows the not-supported state. |
| ELBv2 | IP targets must sit inside the VPC CIDR (172.31.0.0/16). |
| ECR | On AWS Emulator, `docker push` fails with `error from registry: the operation is unsupported` (login works); use `npm run ecr-push -- <local-image> <repo>:<tag>`, which uses the ECR layer APIs. On Floci, `docker push` to the repository URI works (the same script does that automatically). Image scanning isn't offered. |

### CloudWatch Logs from Lambda and ECS

- **Lambda:** the emulator writes `/aws/lambda/<function>` itself, but only if the function's execution role
  allows `logs:CreateLogGroup`, `logs:CreateLogStream` and `logs:PutLogEvents`, as on AWS. Functions created in
  the UI use the helper role, which does. For functions whose role doesn't, invoking from the UI copies the
  invoke log tail into that group, in a stream named `…captured-by-ui-<request id>` and labelled
  **captured by UI** wherever it's shown.
- **ECS:** task definitions registered in the UI use the `awslogs` driver by default, with group
  `/ecs/<family>` (created for you) and the helper role as execution role (Fargate needs one for awslogs).
  On AWS Emulator there is no container runtime: it runs a container's *shell command* (`sh -c "echo …"`) and
  sends its output to the log group, but an image's own program (nginx, node, python) doesn't run.
  **Floci runs real Docker containers**, so those images do run, and awslogs still land in the same group.

### ECS on AWS Emulator vs Floci

- **Network:** Fargate tasks need a route to the registry. The emulator's default VPC has no internet gateway,
  so every task used to stop with `CannotPullContainerError … i/o timeout`. When you run a task or create a
  service in the default VPC, the UI adds an internet gateway and a `0.0.0.0/0` route (once) and assigns a
  public IP. Images in this account's ECR also need pull permissions on the execution role; the helper role has them.
- **Lifetime (AWS Emulator only):** every task stops after about 10 seconds (`EssentialContainerExited`), so a service keeps
  starting replacements. See them under **Tasks → Stopped**, with their stop reason.
- **512-task limit (AWS Emulator only):** the emulator holds at most 512 tasks in total, stopped ones included, and frees them only
  when their cluster is deleted. A service left running fills that in a couple of hours, after which RunTask and
  CreateService fail with `this emulator holds at most 512 tasks; stop some before running more`. Scale services
  to 0 when you're done, or delete the cluster. The seed creates `demo-web` with a desired count of 0.
- **Floci:** tasks run as real Docker containers for as long as the process inside them runs. A service with
  `desiredCount: 1` keeps that many tasks and replaces a container you kill. Publish of awsvpc ports to
  `127.0.0.1` is turned on in `start-local.sh --floci`, so you can curl the task's host port. Floci has no
  10-second stop and no 512-task cap of the AWS Emulator kind.
- **Regions:** cluster names are shared across regions. Creating `x` in one region when `x` exists in another
  returns the existing cluster, so the UI refuses with a clear message.

### Regions

SQS, SNS, Secrets Manager, Step Functions and DynamoDB are separate per region in the emulator. Lambda, ECS,
CloudWatch Logs, Scheduler, ELB and ECR list resources from every region. The UI filters those lists by the
region in each ARN, because passing another region's ARN back to the emulator fails (for example ECS
`InvalidParameterException: Invalid Region in ARN`). API Gateway has no ARNs to filter, so APIs show in every
region; S3 buckets are global.

## Known gaps

- Both backends keep everything in memory by default, so restarting a backend wipes its resources (run `npm run seed` again against that backend).
- The emulator returns epoch timestamps with nanosecond precision, which the JS SDK rejects. `src/lib/compat.ts`
  trims them to milliseconds before deserializing.
- Create forms are deliberately minimal: Fargate/awsvpc task definitions, MOCK integrations for REST methods,
  HTTP listeners only, a single-file Lambda template, and uploads up to 25 MB.
- No IAM, VPC or CloudWatch Metrics pages. When you don't pass a role, the UI uses one helper role,
  `aws-emulator-ui-role`, for Lambda, Step Functions, Scheduler and ECS. It trusts those services and has an
  inline policy for CloudWatch Logs, ECR pulls and the integrations the UI offers.
