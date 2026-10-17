# The `staging` branch

Merging to `staging` deploys Claxedo Cloud staging. One workflow owns the run:
`.github/workflows/deploy-staging.yml`.

## What a push to `staging` does

| # | Job | What it deploys | Reusable workflow / script |
| - | --- | --- | --- |
| 1 | `plan` | nothing — selects components | `script/deploy-components.mjs` |
| 2 | `gate` | nothing | `bun run lint`, `bun typecheck`, `bun run test:ci-policy`, `bun run test:architecture-ratchets` |
| 2 | `unit` | nothing | `.github/workflows/test.yml` with `linux-unit-only` (full unit suite, Linux) |
| 3 | `boat-image` | the Boat sandbox image this checkout builds, with every control-plane deploy | `packages/claxedo-server/scripts/sandbox/build-sandbox-image.ts --agent-plugins --push-if-missing` |
| 3 | `control-plane` | Better Auth + D1 Worker, **the browser app and the session-host Worker** | `packages/claxedo-server/scripts/deploy/deploy-user-cloudflare.ts` |
| 4 | `relay` | workspace relay Worker (Durable Object) | `packages/workspace-relay/scripts/deploy-cloudflare.ts` |
| 5 | `sandbox-image` | Cloudflare sandbox Worker container image | `.github/workflows/deploy-cloudflare-sandbox-worker.yml` |
| 6 | `result` | nothing — fails the run if a selected component did not succeed | inline |

`gate` and `unit` run in parallel; every deploy job then runs strictly in
order, each `needs:` the one before it. `gate` runs the full repository rather
than the affected surfaces `typecheck.yml` selects — the branch being released
is what has to be green, not the diff that reached it. `unit` is `test.yml`
called as a reusable workflow, so a red suite blocks the release through
`needs:` instead of through a race between two independent runs. It is called
with `linux-unit-only`: the whole unit suite on Linux, no Windows leg and no
e2e. Every e2e job now reaches real Playwright results and every one of them
has failing tests (run 35737110865 on 2026-09-22: 12 core shards, both
onboarding legs and tier-real), and the Windows leg is still red in package
suites after its embedded OpenCode verification step (fixed 2026-09-22), so a
gate that required them would never open. They still run on every push to
`dev` through `test.yml` itself; once they are green, drop the input here and
in `deploy-staging.yml`. `staging` is deliberately absent
from `test.yml`'s `push.branches`: a push trigger would run the same suite a
second time in a run the deploy does not depend on.

The whole run shares the `claxedo-cloud-deploy` concurrency group with
`deploy-claxedo-app-staging.yml`, and a queued run waits instead of cancelling.

### The browser app is not a separate job

`deploy-user-cloudflare.ts` builds the app against the API origin it deploys,
publishes it to the `claxedo-user-deployed-app-staging` Worker on
`CLAXEDO_STAGING_APP_ORIGIN`, and waits until the served
`claxedo-browser-build.json` carries the hash of that build. That is the staging
web app. The Cloudflare Pages project `claxedo-app-staging` is the retired
Clerk/Convex-era app; `deploy-claxedo-app-staging.yml` still deploys it on
dispatch, and pointing it at this control plane means repointing the `staging`
environment's `CLAXEDO_CONTROL_PLANE_URL` and `CLAXEDO_APP_URL` first.

### The session-host Worker is not a separate job

After the control-plane Worker serves its new version, `deploy-user-cloudflare.ts`
publishes `packages/session-host` (one `SessionDO` per top-level Pi session) as
`CLAXEDO_SESSION_HOST_WORKER_NAME`, `claxedo-session-host-staging` on staging. It
binds the control-plane Worker as its `CONTROL_PLANE` service, so it is published
after it, and the relay binds its `SessionDO` as `SESSION_HOST` by that script
name, so the relay job comes after both. The dry run bundles it too. Its
variables are the control plane's `/api/runtime-authority/session-authorize` and
the relay's `/.well-known/jwks.json`; it has no secret.

### The relay

Staging's relay is the Durable Object Worker
(`packages/workspace-relay/src/worker.ts`), deployed under the name the control
plane's `CLAXEDO_WORKSPACE_RELAY_URL` resolves to.

`wrangler deploy` replaces a Worker's whole plain-text var set with what the
config and `--var` declare, and `wrangler.toml` cannot name one deployment's
origins. `deploy-cloudflare.ts` therefore passes `CLAXEDO_CENTRAL_URL` (the
resolver base the host-tunnel serving-generation fence derives from) and
`CLAXEDO_APP_ORIGINS` (the CORS allowlist) explicitly; dropping either would be
silent.

### Which images ship

`script/deploy-components.mjs` picks the deploy's components (tested by
`bun run test:ci-policy`). The control plane always deploys with the Boat image
of its own checkout (`boat-image`), since any organization may add a Boat key.
Staging's own Cloudflare sandbox Worker ships with every full deploy, after the
relay, but only when the digest of the files its image and Worker are built from
(its Dockerfile, `wrangler.toml`, `package.json`, `package-lock.json`, `src/` and
the bundled `.build/`) differs from the `DEPLOY_INPUTS` the deployed Worker
records; otherwise the job skips the ~4.5 GB image build. Dispatching
`sandbox-image` by name redeploys it whatever it records. That Worker posts idle
stops only if it and the control plane share `CLAXEDO_SANDBOX_IDLE_STOP_TOKEN`.

## Staging runs the user deploy

The `control-plane` job is `bun run deploy:user-cloudflare -- --agent-plugins`,
the same command a user runs against their own account
(`public-docs/user-deployed-cloudflare.md`), with staging's names passed as
settings: the Worker keeps `claxedo-user-deployed-locked-staging` and the app
keeps `claxedo-user-deployed-app-staging`, because their Durable Object
namespace and custom domains live on those names. It finds the two D1
databases by name, admits only an empty or baseline control-plane database,
applies the control-plane baseline and auth migrations, provisions the native OAuth
clients, deploys the Worker with `wrangler deploy`, and waits until `/health`
names the version it deployed. The new version serves as soon as Cloudflare
switches traffic.

The deploy refuses a control-plane D1 that does not hold exactly the current
baseline; rows are never converted. To reset staging, delete that database
(wrangler asks to confirm) and rerun the `control-plane` job, which recreates
it empty by name and applies the baseline. The recreated database is placed
at `CLAXEDO_STAGING_D1_LOCATION` (the 2026-10-05 reset created it in ENAM with
no location), and the job prints where each database runs.
`CLAXEDO_STAGING_WORKER_PLACEMENT_REGION` pins the Worker beside the databases
(`aws:us-east-1` for ENAM): smart placement left the staging Worker in LHR
(`cf-placement: remote-LHR`) with both databases in ENAM, and every signed
request from India then took 1.5–3 s. `AUTH_DB` is untouched.

```sh
bunx wrangler d1 delete <CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME>
```

Once the job has deployed, sign in to the staging app with GitHub and claim the
deployment's owner again. The script lives in `packages/claxedo-server` and
reads the same settings as the `control-plane` job; without them it targets a
fresh user deployment's Workers and databases. The values are the staging
environment's variables:

```sh
cd packages/claxedo-server
CLOUDFLARE_ACCOUNT_ID=683a2c01a4d43b2fa998cde8ddedaf0e \
CLAXEDO_WORKER_NAME=claxedo-user-deployed-locked-staging \
CLAXEDO_APP_WORKER_NAME=claxedo-user-deployed-app-staging \
CLAXEDO_SESSION_HOST_WORKER_NAME=claxedo-session-host-staging \
CLAXEDO_DEPLOYMENT_ID=acc-stg-260830-232009-3851 \
CLAXEDO_API_ORIGIN=https://api.claxedo.dev \
CLAXEDO_APP_ORIGIN=https://app.claxedo.dev \
CLAXEDO_AUTH_D1_DATABASE_NAME=claxedo-acc-auth-stg-260830-232009-3851 \
CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME=claxedo-acc-control-stg-260830-232009-3851 \
bun run deploy:user-cloudflare:claim-owner --email <your GitHub email>
```

It prints one line to paste into the developer console of the signed-in app tab.

Staging's auth database still holds tables no code reads: `deploymentRelease*`,
`deploymentCutover*` and `deploymentRecoveryEpoch`. Their restrict foreign keys
make a drop impossible on D1, and a fresh database never creates them.

A deploy also drops the `CLAXEDO_CREDENTIALS` KV binding that was added to the
Worker out of band. That is correct: hosted credentials moved to
`CONTROL_PLANE_DB` (dev `1ed25c7c4f`) and no source reads the KV namespace.

### The deploy carries no sandbox provider account

The `control-plane` job deploys the full-hosted Worker. Which provider a cloud
workspace starts on is not a deploy setting: an organization owner or admin
adds a Cloudflare or Boat key under Settings → Sandbox providers (or in the first
run's "Where it runs" step), and every workspace of that organization starts on
the key it chose. The deploy carries only what those drivers need from the
deployment itself:

| Setting | Where | What it is |
| - | - | - |
| `CLAXEDO_SANDBOX_IMAGE` | set by the `boat-image` job | the workspace-runtime image a Boat sandbox boots |
| `CLAXEDO_SANDBOX_IDLE_STOP_TOKEN` | `staging` environment secret, optional | the shared secret a Cloudflare sandbox Worker posts idle stops with; unset, idle stops are refused |
| `CLAXEDO_BOAT_TEMPLATE_API_KEY` | repository secret, required | the release's own Boat key, which builds, shares and prunes the image's runtime template; scopes `sandbox.create`, `sandbox.read`, `sandbox.update`, `sandbox.stop`, `sandbox.resume`, `sandbox.delete`, `exec`, `file.write`, `host`, `snapshot.read`, `snapshot.write` |
| `CLAXEDO_BOAT_RUNTIME_TEMPLATE` | Worker secret set by the `control-plane` job | the image and the share code a new Boat sandbox of that image starts from |

A Boat sandbox `docker run`s the exact workspace-runtime image the control
plane names in `CLAXEDO_SANDBOX_IMAGE`. The `boat-image` job sets it: it bundles
the checkout's runtime host with Agent Plugins, whose content-addressed tag
(for example
`ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-0-10-0-149c6f9a9d-agent-plugins-v8`)
names that bundle, pushes the image (`linux/amd64`, public on ghcr.io) only
when the registry does not hold the tag yet, and hands the tag to
`control-plane`. A runtime change therefore reaches new Boat sandboxes with the
deploy that ships it, and an unchanged runtime reuses its image without a
Docker build. The `boat-image` job then builds the image's Boat runtime
template once (`bun run --cwd packages/claxedo-server sandbox:boat-template
--image=<tag>`, 144 s on Boat on 2026-10-15, on one builder sandbox it deletes after),
and the `control-plane` job mints a share code for it, uploads it as
`CLAXEDO_BOAT_RUNTIME_TEMPLATE`, and only after the deploy succeeded revokes the
template's other codes and prunes templates of older images; see the sandbox-manager README's "Boat runtime
template" for what the template holds and costs. The `sandbox-image` component of this workflow deploys the
Cloudflare sandbox Worker the staging organization's Cloudflare key points at;
its URL and API token are that key's fields, entered in the app, not deploy
inputs.

`bun run --cwd packages/sandbox-manager live:boat -- --yes-live --image=<tag>`
with `BOAT_API_KEY` in the environment checks a key and an image against the
real Boat API: it creates one sandbox, boots the image, reaches
`/global/health` through the published URL, stops, resumes, checks again, and
deletes the sandbox.

## Rerunning one component

Dispatch `deploy-staging` from the Actions tab and pick `components`:
`control-plane`, `relay` or `sandbox-image`. The other components are skipped
and `result` does not require them. The gate and the CI suite run unless an
earlier `deploy-staging` run for the same commit passed both
(`script/deploy-ci-passed.mjs`, tested by `bun run test:ci-policy`); a push
always runs them.

## Deploying from a laptop

Export the same settings the `control-plane` job sets (see its `env:` block in
`deploy-staging.yml`) and run, from `packages/claxedo-server`:

```
bun run deploy:user-cloudflare -- --agent-plugins --dry-run
bun run deploy:user-cloudflare -- --agent-plugins
```

The dry run prints the plan and bundles the Worker without Cloudflare
credentials, and is the fastest way to check the environment is wired.

## The desktop app is not part of this

The desktop release is tag-driven: pushing a `claxedo-v*` tag (on `staging` or
anywhere else) triggers `.github/workflows/release-claxedo.yml`, which builds,
signs, notarizes and publishes the installers. It hard-codes `CLAXEDO_CHANNEL:
prod` in five places (workflow `env` plus the build and three package steps) and
has no channel input, so a tag on `staging` produces a **production-channel**
build. Shipping a staging-channel desktop build needs a change to that
workflow, not to this one.

## Recovery

**A deploy broke staging.** Roll the Worker back to the previous version with
`wrangler rollback --name claxedo-user-deployed-locked-staging` (and
`--name claxedo-user-deployed-app-staging` for the app).
`wrangler d1 time-travel restore` restores data; the next deploy admits the
control-plane database only if it holds the current baseline.

**The relay answers `mode: "node"` or stops resolving targets.** A deploy that
omitted `CLAXEDO_CENTRAL_URL` removed it from the Worker. Rerun the `relay`
component; `deploy-cloudflare.ts` refuses to build a command without it.

### Product telemetry is a staging setting

The `control-plane` job passes `CLAXEDO_TELEMETRY_MODE`, `CLAXEDO_POSTHOG_HOST` and the
`CLAXEDO_POSTHOG_KEY` secret to the deploy (`packages/claxedo-server/src/platform/telemetry/README.md`
lists what is sent). The deploy replaces the Worker's whole variable set, so a value set on the
Worker by hand is gone after the next deploy; set them on the `staging` environment instead:

| `staging` environment variables | `staging` environment secrets |
| - | - |
| `CLAXEDO_STAGING_TELEMETRY_MODE` (`on` or `off`), `CLAXEDO_STAGING_POSTHOG_HOST` (optional) | `CLAXEDO_POSTHOG_KEY` (required when the mode is `on`) |

```sh
gh variable set CLAXEDO_STAGING_TELEMETRY_MODE --env staging --body on
gh variable set CLAXEDO_STAGING_POSTHOG_HOST --env staging --body https://us.i.posthog.com
gh secret set CLAXEDO_POSTHOG_KEY --env staging          # paste the PostHog project key
gh workflow run deploy-staging.yml -f components=control-plane
```

A user deploy takes the same three names from its environment
(`public-docs/user-deployed-cloudflare.md`, Settings).
