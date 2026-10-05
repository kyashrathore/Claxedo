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
- A Worker cancels work left running after its response, so the hosted core keeps the sink's `flush()` alive
  past every response (`keepAlivePastResponse`): a capture any route started still reaches PostHog.
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
| `ui_error_shown` | `claxedo-app/src/i18n/error-copy.ts` `useErrorCopy(surface)`, once per error object | `error_class`: the app's error classes; `surface`: startup, connections, organization, terminal, usage, review |
| `feature_used` | `claxedo-app/src/server/terminals.ts` create, `claxedo-app/src/server/marketplace.ts` activation on, `claxedo-app/src/panel/store.tsx` show and review toggle | `feature`: terminal, marketplace_install, file_open, review |
| `turn_completed` | `usage/turn-completed-telemetry.ts`, wrapping the hosted usage writer | one per settled usage row the ledger accepts (a turn of several model calls is several rows): `harness`, `model_family`, `outcome`, `settlement`, `location`, `tokens_bucket`, `duration_ms` (since the turn's admission, when the row belongs to the reporting lease's turn) |
| `workspace_created`, `workspace_deleted` | `routes/hosted/workspace.ts`, `workspace/cloud-workspace-deletion.ts` | `kind`: cloud; created also `private_repository` |
| `workspace_ready`, `workspace_woken` | `sandbox/sandbox-telemetry.ts` from the sandbox manager's `runtime_ready` phase | `start_ms` (boot start to serving), `boot_mode`, `driver`, `key_owner`, `region`. Opens the metered interval. |
| `workspace_failed` | same, from the manager's `onLifecycle` | `code`: boot_failed, provision_failed |
| `workspace_stopped` | same | `cause`: explicit, idle, deleted; `active_ms` (the boot's machine time). Closes the metered interval. |
| `$exception` | `deployments/hosted-workerd/core-worker.cf.ts` `onError` | an unhandled route error: `route` (the matched pattern), `method`, `code`; never the body |

Machine events (`workspace_ready` … `workspace_stopped`) go out under `system` with the workspace's org as
`$groups.org`; route and app events go out under the signed user with their org.

The ops events (`sandbox.start_phase`, `sandbox.touch`, `sandbox.ensure`, `sandbox.target`,
`workspace.connection.*`, `runtime_access_token.minted`, `usage.dashboard`, `channel.*`) stay as they were,
minus token ids, relay URLs, relay rooms, driver resource ids and free-text reasons.

## Not covered

- VM minutes per period in Usage → Cloud: `sandbox_leases` holds only each workspace's current epoch, so no
  interval history exists to sum. `workspace_stopped.active_ms` carries the measure to analytics.
- Turns on a desktop's own machine are metered in its local ledger and are not sent.
