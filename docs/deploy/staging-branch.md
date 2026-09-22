# The `staging` branch

Merging to `staging` deploys Claxedo Cloud staging. One workflow owns the run:
`.github/workflows/deploy-staging.yml`.

## What a push to `staging` does

| # | Job | What it deploys | Reusable workflow / script |
| - | --- | --- | --- |
| 1 | `plan` | nothing — selects components | inline |
| 2 | `gate` | nothing | `bun run lint`, `bun typecheck`, `bun run test:architecture-ratchets` |
| 2 | `unit` | nothing | `.github/workflows/test.yml` (whole CI suite) |
| 3 | `control-plane` | Better Auth + D1 Worker, browser bundle it serves | `packages/claxedo-server/scripts/deploy/staging-release.ts` |
| 4 | `relay` | workspace relay on Fly | `.github/workflows/deploy-relay.yml` (`environment: staging`) |
| 5 | `sandbox-image` | Cloudflare sandbox Worker container image | `.github/workflows/deploy-cloudflare-sandbox-worker.yml` |
| 6 | `app` | browser app on Cloudflare Pages | `.github/workflows/deploy-claxedo-app.yml` (`target_environment: staging`) |
| 7 | `result` | nothing — fails the run if a selected component did not succeed | inline |

`gate` and `unit` run in parallel; every deploy job then runs strictly in
order, each `needs:` the one before it. `gate` runs the full repository rather
than the affected surfaces `typecheck.yml` selects — the branch being released
is what has to be green, not the diff that reached it. `unit` is `test.yml`
called as a reusable workflow, so a red suite blocks the release through
`needs:` instead of through a race between two independent runs. `staging` is
deliberately absent from `test.yml`'s `push.branches`: a push trigger would run
the same suite a second time in a run the deploy does not depend on.

`sandbox-image` also needs a changed file. It runs only when the push touched
`packages/claxedo-server/scripts/sandbox/`, one of the packages the image
bundles (`sandbox-contract`, `sandbox-manager`, `workspace-runtime`,
`agent-sdk-runtime`, `agent-runtime-contract`, `agent-event-runtime`), or its
own workflow — the image is a ~4.5 GB container build.

The whole run shares the `claxedo-cloud-deploy` concurrency group with
`deploy-claxedo-app-staging.yml`, and a queued run waits instead of cancelling:
a cancelled release leaves the ledger holding a candidate revision nothing
activated.

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

## Rerunning one component

Dispatch `deploy-staging` from the Actions tab and pick `components`:
`control-plane`, `relay`, `sandbox-image` or `app`. The gates still run; the
other components are skipped and `result` does not require them. `sandbox-image`
chosen by name skips the changed-file check.

`deploy-claxedo-app-staging` is still dispatchable on its own for an app-only
redeploy against a control plane that is already live.

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

## Configuring the `staging` GitHub environment

`staging-release.ts --staging --dry-run` prints every derived input — the
predecessor read from the live ledger, the minted release id, the sequence and
the two commands — without deploying, and is the fastest way to check the
environment is wired. It needs the same variables the release does.
