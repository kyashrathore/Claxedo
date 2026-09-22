# The `staging` branch

Merging to `staging` deploys Claxedo Cloud staging. One workflow owns the run:
`.github/workflows/deploy-staging.yml`.

## What a push to `staging` does

| # | Job | What it deploys | Reusable workflow / script |
| - | --- | --- | --- |
| 1 | `plan` | nothing — selects components | `.github/actions/detect-ci-changes` |
| 2 | `gate` | nothing | `bun run lint`, `bun typecheck`, `bun run test:ci-policy`, `bun run test:architecture-ratchets` |
| 2 | `unit` | nothing | `.github/workflows/test.yml` with `linux-unit-only` (full unit suite, Linux) |
| 3 | `control-plane` | Better Auth + D1 Worker **and the browser app** | `packages/claxedo-server/scripts/deploy/staging-release.ts` |
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
e2e. The e2e shards fail before any test runs because those jobs never build
the workspace dist output their helpers import, and the Windows leg fails in
the embedded OpenCode verification; both have been red on `dev` since at least
2026-09-02, so a gate that required them would never open. They still run on
every push to `dev` through `test.yml` itself. `staging` is deliberately absent
from `test.yml`'s `push.branches`: a push trigger would run the same suite a
second time in a run the deploy does not depend on.

The whole run shares the `claxedo-cloud-deploy` concurrency group with
`deploy-claxedo-app-staging.yml`, and a queued run waits instead of cancelling:
a cancelled release leaves the ledger holding a candidate revision nothing
activated.

### The browser app is not a separate job

`release-better-auth-d1.ts --cutover` builds the app against the API origin it
is releasing, hashes it into the release identity (`CLAXEDO_BROWSER_BUILD_ID`),
publishes it to the `claxedo-user-deployed-app-staging` Worker bound to
`CLAXEDO_STAGING_APP_ORIGIN`, and verifies the deployed
`claxedo-browser-build.json` carries that exact hash. That is the staging web
app. The Cloudflare Pages project `claxedo-app-staging` is the retired
Clerk/Convex-era app; `deploy-claxedo-app-staging.yml` still deploys it on
dispatch, and pointing it at this control plane means repointing the `staging`
environment's `CLAXEDO_CONTROL_PLANE_URL` and `CLAXEDO_APP_URL` first.

### The relay is a Worker, not a Fly machine

Staging's relay is the Worker-safe Durable Object relay
(`packages/workspace-relay/src/worker.ts`), deployed under the name the control
plane's `CLAXEDO_WORKSPACE_RELAY_URL` resolves to. `deploy-relay.yml` deploys
the Fly **process** relay; it dispatches to `production` only, because no Fly
staging app resolves in DNS.

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

## Staging is unavailable for about ten minutes

`staging-release.ts` runs `release-better-auth-d1.ts --staging --cutover
--agent-plugins --deploy`, which writes ledger phase `locked` about two minutes
in, then uploads and promotes the Worker with health-convergence retries. Only
the `prepare-better-auth-d1.ts --dev-open --staging` that follows writes phase
`open`. Between those points every route on the API origin answers
`503 {"error":{"code":"deployment_phase_denied"}}` (or
`deployment_candidate_unavailable`), the hosted app fails to boot, and enrolled
hosts stop heartbeating. Do not diagnose "the app failed to start" during this
window; check the ledger phase first.

The release mints `CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT` 90 days out. The
candidate Worker re-checks it on every request, so a staging deployment that is
not re-released within that window starts answering `503
deployment_candidate_unavailable` on `/api/claxedo/*` while `/health` still
reports the release open. Release 84 was minted with a two-day window on
2026-09-05 and died on 2026-09-07.

A release also drops the `CLAXEDO_CREDENTIALS` KV binding that was added to the
Worker out of band. That is correct: hosted credentials moved to
`CONTROL_PLANE_DB` (dev `1ed25c7c4f`) and no source reads the KV namespace.

## Rerunning one component

Dispatch `deploy-staging` from the Actions tab and pick `components`:
`control-plane`, `relay` or `sandbox-image`. The gates still run; the other
components are skipped and `result` does not require them.

## Releasing from a laptop

When the `staging` GitHub environment is not configured yet,
`packages/claxedo-server/scripts/deploy/staging-release.local.sh` assembles the
same inputs from local sources — `CLOUDFLARE_API_TOKEN` through
`script/load-server-env.sh`, and `BETTER_AUTH_SECRET` /
`CLAXEDO_AUTH_INTROSPECTION_SECRET` from the login keychain item
`claxedo-cf-acceptance-260830-232009-3851` / `deployment`, a JSON object keyed
by those names. It defaults to `--dry-run`; `--release` is the explicit opt-in.

`staging-release.ts --staging --dry-run` on its own prints every derived input —
the predecessor read from the live ledger, the minted release id, the sequence
and the two commands — without deploying, and is the fastest way to check the
environment is wired.

## The desktop app is not part of this

The desktop release is tag-driven: pushing a `claxedo-v*` tag (on `staging` or
anywhere else) triggers `.github/workflows/release-claxedo.yml`, which builds,
signs, notarizes and publishes the installers. It hard-codes `CLAXEDO_CHANNEL:
prod` in five places (workflow `env` plus the build and three package steps) and
has no channel input, so a tag on `staging` produces a **production-channel**
build. Shipping a staging-channel desktop build needs a change to that
workflow, not to this one.

## Recovery

**The release refuses: split deployment.** A previous release that failed at
candidate health leaves the Worker with the incumbent at 100% and the candidate
at 0%, and `ensureCutoverLiveSyncLifecycle` refuses it before touching the
ledger. `staging-release.ts` detects it up front and prints the exact command:

```
wrangler versions deploy '<incumbent-version-id>@100%' --name claxedo-user-deployed-locked-staging --yes
```

Confirm `wrangler deployments status --name claxedo-user-deployed-locked-staging --json`
lists one version, then rerun the workflow.

**The release refuses: a candidate revision above the active one.** The same
failure also leaves a `locked` state-history row at `active + 1` that the next
successor insert would collide with. Roll it back:

```
bun run scripts/deploy/prepare-better-auth-d1.ts --rollback-candidate --staging
```

with the stranded release's identity from
`packages/claxedo-server/.artifacts/deployments/staging-<releaseId>.json`
(worker/browser/platform-version/auth-configuration/recovery-epoch), the same
`CLAXEDO_PREVIOUS_*` the failed release used, `CLAXEDO_ROLLBACK_OPERATION_ID`,
`CLAXEDO_WRANGLER_CONFIG` pointing at any config carrying both D1 bindings, and
`BETTER_AUTH_SECRET` / `CLAXEDO_AUTH_INTROSPECTION_SECRET`. That writes a
`prewrite_rollback` row and moves the active pointer to it; the next release
reads the restored revision by itself.

**The release refuses: the active phase is `locked`.** A previous release
registered and activated a candidate but never dev-opened. Finish it:

```
bun run scripts/deploy/prepare-better-auth-d1.ts --dev-open --staging
```

**Every route 503s and the tag on the served version is `-`.** Someone ran
`wrangler secret put` against the Worker, which deploys an untagged "Secret
Change" version the release gate refuses. Redeploy the tagged release version
(`wrangler versions list --name <worker> --json` names it by release sequence),
and provision new secrets through `CLAXEDO_RELEASE_SECRETS_FILE` instead so the
tagged version carries them.

**The relay answers `mode: "node"` or stops resolving targets.** A deploy that
omitted `CLAXEDO_CENTRAL_URL` removed it from the Worker. Rerun the `relay`
component; `deploy-cloudflare.ts` refuses to build a command without it.
