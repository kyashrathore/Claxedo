# The `staging` branch

Merging to `staging` deploys Claxedo Cloud staging. One workflow owns the run:
`.github/workflows/deploy-staging.yml`.

## What a push to `staging` does

| # | Job | What it deploys | Reusable workflow / script |
| - | --- | --- | --- |
| 1 | `plan` | nothing — selects components | `.github/actions/detect-ci-changes` |
| 2 | `gate` | nothing | `bun run lint`, `bun typecheck`, `bun run test:ci-policy`, `bun run test:architecture-ratchets` |
| 2 | `unit` | nothing | `.github/workflows/test.yml` with `linux-unit-only` (full unit suite, Linux) |
| 3 | `control-plane` | Better Auth + D1 Worker **and the browser app** | `packages/claxedo-server/scripts/deploy/deploy-user-cloudflare.ts` |
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

Before deploying the control-plane baseline, reset staging's control-plane D1.
From `packages/claxedo-server`, with Cloudflare credentials in the environment:

```sh
export CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME=<staging control-plane database name>
bun run d1:reset:staging
bun run deploy:user-cloudflare -- --agent-plugins
```

The reset deletes and recreates only the named control-plane database. It
discards its rows; it does not convert them or reset `AUTH_DB`. The deploy
rediscovers the database UUID and binds it to the Worker. Use the same name
as the staging environment's `CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME`
variable; deploy receives it as `CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME`.
An old `d1_migrations` history or a nonempty untracked schema stops deploy
before migrations and names the reset command.

Whenever another lane adds a numbered migration, run
`bun run d1:baseline:generate` before deploying. This folds every current migration into
`migrations/control-plane/0001_baseline.sql` on an empty SQLite database and
removes the numbered inputs. Generation never touches remote D1.

A deploy also drops the `CLAXEDO_CREDENTIALS` KV binding that was added to the
Worker out of band. That is correct: hosted credentials moved to
`CONTROL_PLANE_DB` (dev `1ed25c7c4f`) and no source reads the KV namespace.

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
`--name claxedo-user-deployed-app-staging` for the app). The control-plane
baseline cannot upgrade an old schema; a D1 restore must contain the same
baseline schema before redeploying.

**The relay answers `mode: "node"` or stops resolving targets.** A deploy that
omitted `CLAXEDO_CENTRAL_URL` removed it from the Worker. Rerun the `relay`
component; `deploy-cloudflare.ts` refuses to build a command without it.
