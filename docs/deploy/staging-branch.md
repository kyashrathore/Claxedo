# The `staging` branch

Merging to `staging` deploys Claxedo Cloud staging. One workflow owns the run:
`.github/workflows/deploy-staging.yml`.

## What a push to `staging` does

| # | Job | What it deploys | Reusable workflow / script |
| - | --- | --- | --- |
| 1 | `plan` | nothing — selects components | `.github/actions/detect-ci-changes` |
| 2 | `gate` | nothing | `bun run lint`, `bun typecheck`, `bun run test:ci-policy`, `bun run test:architecture-ratchets` |
| 2 | `unit` | nothing | `.github/workflows/test.yml` with `linux-unit-only` (full unit suite, Linux) |
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

### The sandbox image is selected, not scheduled

`script/ci-changes.mjs` owns which surfaces a diff reaches, and `sandbox_image`
is one of its outputs: the Worker and its build script, plus every package
`build-sandbox-image.ts` bundles into the host it ships. A `workflow_dispatch`
has no base commit, so it selects the ~4.5 GB image build — pick one component
by name to avoid that.

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
it empty by name and applies the baseline. `AUTH_DB` is untouched. Claim the
deployment's owner again afterwards (`bun run deploy:user-cloudflare:claim-owner`):

```sh
bunx wrangler d1 delete <CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME>
```

Staging's auth database still holds tables no code reads: `deploymentRelease*`,
`deploymentCutover*` and `deploymentRecoveryEpoch`. Their restrict foreign keys
make a drop impossible on D1, and a fresh database never creates them.

A deploy also drops the `CLAXEDO_CREDENTIALS` KV binding that was added to the
Worker out of band. That is correct: hosted credentials moved to
`CONTROL_PLANE_DB` (dev `1ed25c7c4f`) and no source reads the KV namespace.

### The sandbox driver is a staging setting

The `control-plane` job deploys the full-hosted Worker, and the `staging`
environment variable `CLAXEDO_STAGING_SANDBOX_DRIVER` picks the driver it boots
cloud workspaces with. There is no default: unset or unknown, the job fails at
"Verify the deploy inputs are configured" before anything is built. Only the
selected driver's settings reach the deploy:

| Driver | `staging` environment variables | `staging` environment secrets |
| - | - | - |
| `cloudflare` | `CLAXEDO_STAGING_SANDBOX_WORKER_URL` | `CLOUDFLARE_SANDBOX_API_TOKEN` (optional once it is on the Worker) |
| `boat` | `CLAXEDO_STAGING_SANDBOX_IMAGE` | `BOAT_API_KEY` |

`CLAXEDO_STAGING_SANDBOX_IMAGE` is the exact workspace-runtime image every Boat
sandbox `docker run`s, for example
`ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-0-10-0-149c6f9a9d-v8`.
`claxedo-sandbox-image.yml` builds and pushes it (`linux/amd64`, public on
ghcr.io) on pushes to `dev` that touch the runtime, and prints the tag in its
job summary. The `sandbox-image` component of this workflow deploys the
Cloudflare sandbox Worker, which only the `cloudflare` driver uses, so `plan`
(bound to the `staging` environment to read the driver) selects it for that
driver alone. Switching drivers
leaves the other driver's secret on the Worker, where nothing reads it.

`bun run --cwd packages/sandbox-manager live:boat -- --yes-live --image=<tag>`
with `BOAT_API_KEY` in the environment checks a key and an image against the
real Boat API: it creates one sandbox, boots the image, reaches
`/global/health` through the published URL, stops, resumes, checks again, and
deletes the sandbox.

## Rerunning one component

Dispatch `deploy-staging` from the Actions tab and pick `components`:
`control-plane`, `relay` or `sandbox-image`. The gates still run; the other
components are skipped and `result` does not require them.

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
