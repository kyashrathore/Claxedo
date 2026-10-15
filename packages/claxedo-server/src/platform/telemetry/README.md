# Product telemetry

One path for the hosted web app and the desktop: the app sends product events to the hosted control plane's
`POST /api/claxedo/track`, the control plane emits its own events from the code that owns each fact, and the
Worker's sink (`platform/auth/worker-telemetry.ts`) forwards everything to PostHog.

## Sending

- A deployment sends only with `CLAXEDO_TELEMETRY_MODE=on` **and** a PostHog key (`CLAXEDO_POSTHOG_KEY`;
  `CLAXEDO_POSTHOG_HOST` picks the ingest host, default `https://us.i.posthog.com`). Anything else is a no-op
  with no network call (`errors/config.ts`).
- Ids leave only as digests: the sink replaces the distinct id, every `*_id`/`*Id` property and every
  `$groups` value with the first 128 bits of SHA-256 over `claxedo:<id>`. `system` stays readable.
- `capture` queues; `flush` posts the queue as one `POST /batch/` and awaits it. A Worker cancels the I/O an
  invocation started once that invocation ends, and a cancelled promise never settles, so a POST begun by a
  capture inside background work or a Durable Object step would hang every later flush that awaited it and
  the invocation keeping that flush alive. The hosted core keeps one `flush()` alive past every response
  (`keepAlivePastResponse`), the sandbox provisioner flushes after each of its own steps, and whatever an
  invocation captured without flushing goes out with the next flush in that isolate. The queue keeps the newest
  1,000 events. A `$exception` is its own awaited POST.
- There is no user or org opt-out in the product today; the deployment switch is the only control.
- The local server mounts no track route and composes no sink. A signed desktop's app events go to its
  account's control plane through Electron main (`telemetry.track` in `@claxedo/account-contract`); an
  unsigned desktop sends nothing.

## The track route

`TelemetryTrackRoutes` (`@claxedo/server-core/platform/telemetry/track-route`), mounted on the hosted core:

- the caller is the signed cookie or bearer session; an unsigned caller is `401`, and a distinct id in the body
  is ignored;
- the body is decoded by `decodeProductEvent` (`@claxedo/account-contract/product-events`): an event outside
  `PRODUCT_EVENTS` or a property value outside its set is `400 telemetry_event_refused`, any other property
  is dropped, so no free text, path, prompt or email can be sent;
- 120 events per caller per minute per isolate (`429` with `retry-after`).

## Events

| Event | Owner | Properties |
| --- | --- | --- |
| `onboarding_step_viewed`, `onboarding_step_completed`, `onboarding_abandoned` | `claxedo-app/src/onboarding/funnel.ts` | `step`: project, ai, execution. Abandoned fires when the wizard is left inside the app; closing the tab sends nothing. |
| `session_started` | `claxedo-app/src/server/sessions.ts` `create` | `harness`: claude, codex, cursor, pi, opencode, connection, default; `where`: machine, cloud |
| `permission_decided` | `claxedo-app/src/session/requests/store.ts` | `decision`: allow, deny, option (a harness-named option); `tool_kind`: bash, edit, write, read, list, grep, glob, websearch, webfetch, task, mcp, other |
| `ui_error_shown` | `claxedo-app/src/i18n/error-copy.ts` `useErrorCopy(surface)`, once per error object | `error_class`: the app's error classes; `surface`: startup, connections, organization, terminal, usage, review, machines, projects, marketplace |
| `feature_used` | `claxedo-app/src/server/terminals.ts` create, `claxedo-app/src/server/marketplace.ts` activation on, `claxedo-app/src/panel/store.tsx` show and review toggle | `feature`: terminal, marketplace_install, file_open, review |
| `turn_completed` | `usage/turn-completed-telemetry.ts`, wrapping the hosted usage writer | once per usage row, on the revision the ledger reports as the first to settle it (a turn of several model calls is several rows; usage that lands after a settled answer, or a stopped turn's recovered usage, revises the row and sends nothing): `harness`, `model_family`, `outcome`, `settlement`, `location`, `tokens_bucket`; `duration_ms` (admission to the row's completion) and `first_token_ms` (admission to the first part the harness streamed, `firstOutputAt` on the fact) when the row belongs to the reporting lease's turn; `error_code` on an `error` outcome, from the fact's `errorClass` (the first-turn error classes). The meter (`claxedo-server-core/src/usage/turn-meter.ts`) sets both fields; neither is hashed or kept by a ledger. A turn that fails before its harness names an assistant message files no row and sends nothing. |
| `credential_checked` | `claxedo-server-core/src/credentials/routes/credential.ts`, `/:id/verify` and `/:id/reconnect` | `provider` (a built-in vendor's or sandbox driver's id; a custom provider is `custom`), `kind`, `verdict`: ok, auth_failed, no_billing, rate_capped, expired, or unsupported, no_secret, failed when the Check could not reach a verdict |
| `workspace_created`, `workspace_deleted` | `routes/hosted/workspace.ts`, `workspace/cloud-workspace-deletion.ts` | `kind`: cloud; created also `private_repository` |
| `workspace_ready`, `workspace_woken` | `sandbox/sandbox-telemetry.ts` from the sandbox manager's `runtime_ready` phase | one per start the person asked for, however many lease epochs it took: `start_ms` (the connect that began the start to serving, across a retried or taken-over epoch), `boot_mode` (cold-start for a host that never served, resume or restore otherwise), `driver`, `org_id`, `region`. Opens the metered interval. |
| `workspace_failed` | same, from the manager's `onLifecycle` | `code`: boot_failed, provision_failed, provider_rate_limited (with `window`: minute, hour or day, the provider's start limit that was used up). Only when the start itself ends: a boot failure, a spent retry budget, or a day's start limit. An epoch that fails while its retry is still ahead sends nothing; the next epoch continues the start. |
| `workspace_stopped` | same | `cause`: explicit, idle, deleted (Claxedo destroyed the machine: a workspace delete or a destroy by hand), host_gone (the provider no longer has the host; the same start places a replacement), host_stopped (the provider stopped the host on its own while it served; the next start resumes it); `active_ms` (the epoch's own machine time). Closes the metered interval. |
| `broker_refused` | `credentials/hosted-egress-broker/index.ts`, sampled | `code` (the credential broker's error codes), `status`, `suppressed`: one event per code per minute per isolate, carrying how many refusals of that code the previous event stood for. No request detail. |
| `$exception` | `deployments/hosted-workerd/core-worker.cf.ts` `onError` | an unhandled route error: `route` (the matched pattern), `method`, `code`; never the body |

Machine events (`workspace_ready` … `workspace_stopped`) and `broker_refused` go out under `system`; machine
events carry the workspace's org as `org_id` and `$groups.org`. Route and app events go out under the signed
user with their org.

Every event about a workspace names it as `workspace_id` (digested), the route events through
`captureWorkspaceTelemetry` (`workspace/route-support.ts`), which also sets `org_id` and `$groups.org` from the
workspace row or the admission, and the machine events, `sandbox.touch` and `sandbox.egress_unenforced` through
`sandboxWorkspaceKeys` (`sandbox/sandbox-telemetry.ts`), which reads the org from the placement's labels, so one
query joins a workspace from `workspace_created` to its stops.

## Ops events

| Event | Owner | Properties |
| --- | --- | --- |
| `workspace.connection.requested` | `connections/hosted-connection-info.ts`, `connections/host-tunnel-connection.ts` | `backing`, `homeRegion`; a tunnel also `hostId` |
| `workspace.connection.unavailable` | `connections/hosted-connection-info.ts` | `backing`, `homeRegion`, `retryAfterMs` |
| `sandbox.ensure` | `workspace/cloud-workspace-start.ts` | one per start decision, not per poll that joined the run in flight, whether a person's connect or a session host's tool call asked for it (`startedBy: "session_host_tool"`, under the workspace owner's organization): `status`, `homeRegion` (a connect's), `leaseEpoch`, `retryAfterMs`, `code`, `hostId` |
| `sandbox.target` | same | `status`, `homeRegion`, `reason`, `leaseStatus`, `hostId`, `leaseEpoch` |
| `sandbox.touch` | `authority/sandbox-relay-target.ts` | `workspace_id`, `org_id`, `touched`, `status` |
| `sandbox.start_phase` | `sandbox/sandbox-telemetry.ts` | per epoch: `phase`, `duration_ms`, `epoch`, `region`, `boot_mode`, `repo_size_bytes` |
| `sandbox.egress_unenforced` | `sandbox/sandbox-telemetry.ts` | `phase`, `reason`, `driver`, `egress_control`; the `ensure` phase also `workspace_id`, `org_id` and the withheld counts. The `composition` phase is the deployment's, once per driver per isolate, and names no workspace. |
| `sandbox.garbage_collect`, `sandbox.release` | `routes/hosted/sandbox-admin.ts` | the sweep's counts; a release names its workspace and whether it released |
| `runtime_access_token.minted` | the connection paths | `backing`, `role`, `homeRegion`, `leaseEpoch` |
| `host_workspace_assignment.assigned` | `workspace/host-assignment-handlers.ts` | `hostId` |
| `control_plane.auth.denied` | `workspace/route-support.ts` `signedOrError`, under `system` | `code`, `status` |
| `usage.dashboard` | `claxedo-server-core/src/usage/routes.ts`, under `system` | the dashboard read's latency and token counts |
| `channel.session.created`, `channel.access.denied` | `channels/control-plane.ts` | `channel`, `chatType`, `reason` |

Token ids, relay URLs, relay rooms, driver resource ids and free-text reasons stay out of all of them.

## Machine time in the product

VM minutes per period in Usage → Cloud are not read from analytics. The D1 lease store
(`sandbox/stores/d1.ts`) records each boot's interval in `sandbox_boots` (`sandbox/stores/d1-boots.ts`) in the
same batch as the write that takes a serving epoch out of `ready`: a stop by hand or by idleness, a delete, a
restore that replaces the machine, a release, or a failure. `GET /api/claxedo/usage/machine-time` sums the
signed person's own boots in the period, plus their epochs still serving. `workspace_stopped.active_ms` is the
same interval, but only stops and deletes send it.

## Not covered

- Turns on a desktop's own machine are metered in its local ledger and are not sent.
- Machine time has no price: no per-machine-class rate exists, so Usage → Cloud shows minutes and no cost.
