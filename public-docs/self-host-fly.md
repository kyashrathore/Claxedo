# Self-Host on Fly.io

`claxedo deploy` self-hosts the Claxedo control plane on your own Fly.io
account, end to end. It asks the few real questions (harness, tool placement,
platform), derives everything else, drives `flyctl` for you, and is only "done"
once the deployed machine answers its health check.

The default is a **zero-Convex, zero-Clerk, unsigned single-user** instance: the
SQLite workspace authority is the built-in default, so no external accounts or
extra secrets are required to bring one up. Signed/hosted mode is a later,
opt-in layer (see below).

> The v1 wizard runs **from a clone of the Claxedo monorepo** (self-host from
> source). It looks upward from the current directory for
> `packages/claxedo-server/Dockerfile` and refuses to run if it can't find it.
> A prebuilt-image path lands with the GHCR publish.

## Prerequisite: flyctl

Install the Fly CLI and log in — the platform CLI owns auth; Claxedo never
reimplements the Fly API:

```sh
# https://fly.io/docs/flyctl/install/
fly auth login
```

The wizard verifies both before it touches your account: it runs
`flyctl version` (and tells you to install it if missing) and
`flyctl auth whoami` (and tells you to `fly auth login` if you are not logged
in).

## Run the wizard

From anywhere inside your monorepo clone:

```sh
claxedo deploy
```

It walks three prompts:

1. **Harness** — `pi` (default), `opencode`, or `claude-code`.
2. **Tool placement** — asked only for `pi`, which supports split tool
   execution: `This server` (default; tool processes share the machine),
   `Daytona` (fresh isolated container per session — needs a Daytona API key),
   or `Cloudflare sandboxes` (containers on your CF account — needs a CF API
   token and sandbox worker URL). Other harnesses always run brain+hands on the
   server itself.
3. **Platform** — `Fly.io` is the only target in v1. Railway, Render,
   Cloudflare, and Vercel are shown but disabled with the reason each is not yet
   a fit (serverless timeouts, no persistent disk, etc.).

It then asks for an **app name** (default `claxedo-selfhost`, globally unique on
Fly) and a **Fly region** (default `sin`).

### Flags

Every prompt has a flag, so the wizard runs unattended in CI or scripts:

| Flag              | Effect                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `--generate-only` | Write the `fly.toml` and print the manual `flyctl` steps; do not deploy.                    |
| `--yes`, `-y`     | Accept every default (harness `pi`, tools `this-server`, platform `fly`, app/region defaults) and skip prompts. |
| `--app <name>`    | App name (also `--app=<name>`).                                                             |
| `--region <code>` | Fly region (also `--region=<code>`).                                                        |
| `--harness <id>`  | `pi`, `opencode`, or `claude-code`.                                                         |
| `--tools <id>`    | `this-server`, `daytona`, or `cloudflare` (only meaningful for `pi`).                       |

## What the wizard generates

It writes `<app>.fly.toml` at the monorepo root — safe to edit and re-deploy
with `fly deploy -c <app>.fly.toml`. The generated config:

- builds from `packages/claxedo-server/Dockerfile` (build context is the repo
  root, so `fly deploy` must run from the monorepo root — the wizard does this
  for you);
- sets `CLAXEDO_SERVER_HOST = "0.0.0.0"`, `CLAXEDO_SERVER_PORT = "3001"`, and
  `CLAXEDO_DATA_DIR = "/data"`;
- mounts a `claxedo_data` volume at `/data` (this is where the SQLite authority
  and workspace state live);
- exposes an `http_service` on `3001` with `force_https`, a single always-on
  machine (`auto_stop_machines = "off"`, `min_machines_running = 1`), and a
  `GET /api/claxedo/health` check;
- requests a `shared-cpu-2x` machine with **4 GB of memory**.

### Why 4 GB, not 2 GB

The embedded engine (node-embed) **OOMs a 2 GB machine on first load**, so the
generated `[[vm]]` block requests `memory = "4gb"`. This mirrors the in-repo
`packages/claxedo-server/fly.toml`. Do not trim it back to 2 GB — a machine that
boots but dies under first real load is worse than one that never boots. If you
later run purely split-tool workloads and want to experiment with a smaller
machine, do it deliberately and watch `fly logs` for OOM kills.

## The deploy sequence

With no `--generate-only`, the wizard runs these stages and treats "deployed" as
**verified**, not "commands ran":

1. **flyctl present + logged in** (`flyctl version`, `flyctl auth whoami`).
2. **App + volume** — idempotent: `flyctl apps create <app>` ("already exists"
   is fine), then a `claxedo_data` volume via
   `flyctl volumes create claxedo_data --app <app> --region <region> --size 10 --yes`
   if one isn't already present.
3. **Secrets** — only for the chosen tool placement, staged with
   `flyctl secrets set ... --stage`:
   - Daytona → `DAYTONA_API_KEY`
   - Cloudflare → `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_SANDBOX_WORKER_URL`
   Model/provider keys are **not** set here — you configure those in-app after
   first login.
4. **Deploy** — `flyctl deploy -c <app>.fly.toml --remote-only` (Fly's remote
   builder, so no local Docker needed).
5. **Health poll** — the wizard polls
   `https://<app>.fly.dev/api/claxedo/health` up to 36 times at 5-second
   intervals. If health never goes green, it fails and points you at
   `fly logs --app <app>`.

On success it prints the healthy URL, plus a warning that **this instance runs
without authentication** — built-in accounts are not shipped yet, so anyone with
the URL can use it. Keep it private (Fly private networking, or destroy it after
testing) until sign-in ships.

### Generate-only

`claxedo deploy --generate-only` writes the config and prints the manual path
instead of deploying:

```sh
fly apps create <app>
fly volumes create claxedo_data --app <app> --region <region> --size 10 --yes
fly secrets set <KEY>=... --app <app> --stage        # per chosen tool placement
fly deploy -c <app>.fly.toml --remote-only
open https://<app>.fly.dev
```

## The default: unsigned, single-user

Out of the box the instance is unsigned and single-user. The SQLite workspace
authority is the default backend, so there is **no Convex and no Clerk** and no
extra secrets to provision. `CLAXEDO_DEPLOYMENT_MODE` is deliberately left
unset — absent mode means self-host by design; never set it to `hosted` on a
self-host machine.

Volume and data:

- All persistent state lives on the `claxedo_data` volume at `/data`
  (`CLAXEDO_DATA_DIR`). The generated volume is 10 GB; grow it with
  `fly volumes extend` as your history and worktrees accumulate.
- Because the app is a single always-on machine with local disk, do not scale it
  above one machine in this mode — the SQLite store and live sessions live on
  that one machine.

## Layering signed / hosted mode later

Signed mode (real accounts, hosted workspace authority, relay) is additive: keep
the same Fly app and add the signing/identity secrets. Use
`packages/claxedo-server/.env.example` as the source of truth for the exact
names, and set each with `fly secrets set` — for example the Clerk verification
inputs (`CLERK_JWT_ISSUER`, `CLERK_JWKS_URL`, `CLERK_SECRET_KEY`), the workspace
authority and relay URLs, and the runtime-access-token signing key. The hosted
Cloudflare Worker shape and its full required/optional matrix are documented in
`public-docs/hosted-control-plane-worker.md`; the operational deploy and
rollback doctrine is in `public-docs/deploy-runbook.md`.

## Telemetry

Telemetry defaults to **off** here — a self-hosted instance sends nothing unless
you turn it on. PostHog is Claxedo's only telemetry vendor, covering both
product analytics and error tracking.

Set these as Fly secrets (`fly secrets set NAME=value --app <app>`) to turn it
on:

| Name                                         | Purpose                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CLAXEDO_TELEMETRY_MODE`                     | `on` or `off`. Checked before key presence — `off` (the self-host default) means no telemetry no matter what else is set. |
| `CLAXEDO_POSTHOG_KEY`, `CLAXEDO_POSTHOG_HOST` | Your PostHog project key and host. Inert while `CLAXEDO_TELEMETRY_MODE` is unset or `off`.                                |

Enabling it sends feature-usage events and exception reports tagged with your
user and organization identifiers — never prompts, source text, credentials,
repository contents, or literal file paths (paths are reduced to an extension
plus a one-way hash). Full data posture: the
[privacy policy](https://claxedo.com/privacy).

## Rollback

A Fly rollback is itself a deploy: find the last good image with
`fly releases -a <app> --image` and redeploy it. Note that a rollback applies
the _current_ `fly.toml` and secrets, not those from the old release — the
in-repo config is the only source of config truth. See
`public-docs/deploy-runbook.md` for the full per-unit rollback doctrine.
