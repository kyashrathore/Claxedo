# Sandbox provider setup, prebuilds and machine sizes

Status: slice 1 implemented on `feat/sandbox-start-telemetry`; slices 2–5 planned.

A cloud workspace start today boots the workspace-runtime image, clones the repository and installs nothing, every
time. This plan makes provider keys an org setting, makes a repository's setup explicit, boots new workspaces from a
prebuilt snapshot of that setup, and lets a workspace choose its machine size. It starts by measuring the start, so
every later slice is judged against numbers.

## Decisions (owner, 2026-10-04, binding)

- **Provider keys are org keys.** A hosted sandbox provider key is an org credential of kind `sandbox_driver` in the
  shared credential store, added, verified and listed through the shared credentials route. Personal provider keys
  exist only on a local machine. The deployment's operator key (for example `BOAT_API_KEY`) stays the default managed
  driver; an org key, when present, wins for that org.
- **Setup format.** `.claxedo/setup.sh` runs at prebuild time and `.claxedo/start.sh` on every boot. They are the only
  setup format; there is no `devcontainer.json`. A repository with neither gets its package manager detected from its
  lockfile.
- **Prebuild branches.** Each project lists the branches that get prebuilds. The default branch is on the list unless
  someone removes it. The list holds branches, never sandboxes.
- **One prebuild per key.** A successful build replaces the current prebuild and deletes the old snapshot at once.
  Claxedo tracks no sandboxes for this: sandboxes are ephemeral, and a sandbox booted from a prebuild has its own disk.
  A provider that ties a running sandbox to its base snapshot handles that inside its driver, not through a Claxedo
  list.
- **Deletion.** A prebuild is deleted when its branch leaves the project's prebuild list or is deleted, or when its key
  goes 14 days without a workspace start.
- **Machine size.** Each driver declares its machine classes in `packages/sandbox-manager/src/driver-catalog.ts`. The
  workspace stores its choice, with a default per project and per org.

## Measurement

Every cloud start records its phases into its lease epoch and reports each one as an ops-plane event,
`sandbox.start_phase`, through the control plane's existing PostHog sink (`workerTelemetry`). The event carries
`phase`, `duration_ms`, `workspace_id`, `epoch`, `driver`, `region`, `boot_mode` (`cold-start`, `restore`, `resume`),
`project_id`, and `repo_size_bytes` on the checkout phase. It never carries source code, paths, the repository URL or
secrets, and it is sent under `distinct_id: "system"`, like the other ops events. `machine_class` joins the tags in
slice 5, when a workspace has one.

| Phase | Ends when | Observed by |
|---|---|---|
| `lease_decision` | The manager has chosen resume, restore or cold start | `SandboxManager.ensure` |
| `provider_ready` | The driver reports the provider resource (`onResource`) | sandbox manager |
| `image_ready` | The driver sees the sandbox running from its image or snapshot (`onImageReady`: Boat after the container starts, Vercel after create) | sandbox manager |
| `repository_checkout` | The runtime has checked out the repository, timed inside the sandbox | runtime, taken by the control plane after provisioning |
| `start_script` | `.claxedo/start.sh` or the detected install has finished (slice 3) | runtime |
| `runtime_ready` | The driver returns a serving target | sandbox manager |
| `first_session_ready` | The runtime publishes the first session created after the start began | session rows ingest |

The control-plane phases are timed from the previous one, so `lease_decision + provider_ready + image_ready +
runtime_ready` is the wall time from the first `ensure` to a serving runtime. A driver that cannot tell a phase apart
(Modal's create returns only once the runtime is up) leaves it out, and its time falls into the next phase.
`repository_checkout` and `start_script` happen inside the `runtime_ready` span and break it down.
`first_session_ready` is timed from `runtime_ready`.

Prebuild phases are defined for slice 4: `builder_ready`, `fetch`, `setup_script`, `quiesce_and_scrub`, `snapshot`,
`registry_write`, timed with the same `createSandboxPhaseTimer` the runtime uses.

### Recent starts for one repository

Run this in PostHog SQL with the project id:

```sql
select
  properties.workspace_id as workspace,
  properties.epoch as epoch,
  min(timestamp) as started,
  any(properties.driver) as driver,
  any(properties.region) as region,
  any(properties.boot_mode) as boot_mode,
  max(toInt(properties.repo_size_bytes)) as repo_size_bytes,
  maxIf(toInt(properties.duration_ms), properties.phase = 'lease_decision') as lease_decision_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'provider_ready') as provider_ready_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'image_ready') as image_ready_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'repository_checkout') as checkout_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'start_script') as start_script_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'runtime_ready') as runtime_ready_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'first_session_ready') as first_session_ms
from events
where event = 'sandbox.start_phase'
  and properties.project_id = 'prj_…'
  and timestamp > now() - interval 14 day
group by workspace, epoch
order by started desc
limit 50
```

`maxIf` collapses the rare duplicate of a phase written by two concurrent pollers.

## Slices

### 1. Start and prebuild telemetry

- [x] The phase vocabulary and `createSandboxPhaseTimer` live in `@claxedo/sandbox-contract` (`start-phases.ts`).
- [x] `SandboxManager` records each epoch's start in the lease (`SandboxLease.start`, D1 column
  `sandbox_leases.start_json`) and emits `onStartPhase`. One provision call writes what it observed once, after the
  driver work. A phase is emitted at most once per epoch. A serving lease that is re-ensured does not start.
- [x] `recordStartPhases` takes runtime-timed phases; `markStartPhase` ends a phase from outside the manager, refusing
  evidence older than the start.
- [x] The runtime times its checkout and repository size (`hosts/workspace-runtime/runtime-start-phases.ts`). Only the
  control plane can take them, at `RUNTIME_START_PHASES_PATH`, and only once per process.
- [x] Hosted runtime delivery takes them after provisioning (`workspace/runtime-start-phases.ts`). The session rows
  ingest ends `first_session_ready`. The hosted composition sends every phase as `sandbox.start_phase`
  (`sandboxStartPhaseSink`).
- [x] The per-repository read above.

Done when: every cloud start emits its phases with durations, tested with the real sandbox manager and a test driver
(`sandbox-manager/src/start-telemetry.test.ts`, the D1 store, the hosted composition through a PostHog capture server,
and the session rows ingest over D1). Typecheck, lint 0 on touched files, architecture ratchets, the affected package
tests and the server's `verify:closure` all pass.

Progress: implemented. The Worker closures grew by one module (`workspace/runtime-start-phases.ts`); the ceilings
record it. Schema change: `sandbox_leases.start_json`.

### 2. Provider keys on the shared credentials route

- [ ] Delete the driver-key routes (`SandboxDriverSettingsRoutes`, `PUT/DELETE /drivers/:id/auth`) and every caller.
- [ ] Org sandbox provider keys are added, verified and listed through the shared credentials route as kind
  `sandbox_driver`, using the shared verify.
- [ ] An org setting names the org's default driver. The deployment's operator key is the default managed driver, and
  an org key, when present, wins for that org.
- [ ] A Settings "Sandbox" group lists the org's provider keys and the default driver.

Done when: no driver-key route remains; a hosted org adds, verifies, lists and removes a provider key through the
shared credentials route; a workspace in that org starts on the org's key; an org without one starts on the operator
key; tests cover each, plus a member who may not manage org credentials being refused.

### 3. Repository setup

- [ ] The runtime runs `.claxedo/start.sh` on every boot, after the checkout and before it reports ready, and times it
  as `start_script`.
- [ ] With neither `.claxedo/setup.sh` nor `.claxedo/start.sh`, the runtime detects the package manager from the
  lockfile and runs its install as `start_script`.
- [ ] A "set up this environment" agent flow writes `.claxedo/setup.sh` and `.claxedo/start.sh` for a repository and
  opens a pull request.

Done when: a repository with `start.sh` boots with it run and timed; one without boots with the detected install; a
failing script fails the boot with its reason; the agent flow opens a pull request with both files; tests cover each.

### 4. Prebuild registry and builder

- [ ] A prebuild registry keyed by (org, repository, branch, setup-file hash, lockfile hash, base image version,
  driver, region) holds one current prebuild per key.
- [ ] Builds are triggered by a GitHub push webhook for a listed branch and daily. Builds are incremental; a clean
  build runs weekly, when the snapshot passes its size limit, and when the base image changes. One build runs per key,
  and triggers that arrive during it collapse into one follow-up.
- [ ] The builder times its phases with `createSandboxPhaseTimer` and reports them as `sandbox.prebuild_phase`.
- [ ] New workspaces boot the key's current prebuild and fetch the delta from it, on Modal and Vercel first.
- [ ] Retention follows the decisions: a successful build replaces the current prebuild and deletes the old snapshot
  at once. A prebuild is deleted when its branch leaves the project's list or is deleted, or after 14 days without a
  workspace start. No sandbox tracking.
- [ ] Builder security: the builder holds no user credentials. A build-only repository token is withdrawn before the
  snapshot. Registry secrets are scrubbed, and a check refuses a snapshot that still holds a known secret. Every
  prebuild is scoped to its org.

Done when: a push to a listed branch produces a prebuild that the next workspace on that key boots, measurably faster
(by the slice 1 read); concurrent triggers produce one build and one follow-up; each deletion rule removes the snapshot
at its provider; the secret check refuses a seeded snapshot; tests cover each.

### 5. Remaining drivers and machine sizes

- [ ] Cloudflare captures prebuilds as a directory capture and cleans up the captured directories.
- [ ] Boat captures prebuilds as a snapshot or template.
- [ ] Each driver declares its machine classes in `driver-catalog.ts`. A workspace stores its class, with a default per
  project and per org, and the start events carry `machine_class`.
- [ ] A size picker sets the workspace's class and the project and org defaults.

Done when: Cloudflare and Boat workspaces boot from their prebuilds; a workspace started with a chosen class runs on
it and its start events say so; tests cover each driver's capture and cleanup, and the default order.
