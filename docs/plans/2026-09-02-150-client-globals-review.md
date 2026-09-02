# 2026-09-02-150 — Client review: what is still "global" that is not

Status: REVIEW (findings + dispositions). Executes alongside plan 149 (one
catalog, one session source) and after plan 148's performance follow-up.

## The premise the client still carries

The app was written for one server on one machine with one harness: load its
globals at boot (path, projects, providers, provider auth, config, commands,
agents), key every cache by that server's URL, keep one "active server", one
event stream, one persisted model store. Claxedo now has many machines (the
local daemon, cloud sandboxes, the user's own machine over the relay,
teammates' machines over the relay), many harnesses per workspace, and many
models per harness. Where the client already resolves a `workspaceId` and
picks a transport per request it is right (`placement-table.ts`,
`http-backend.ts`, terminals, processes, `harness-config-runtime.ts`,
`workspace-connection.ts`, `session-capabilities-query.ts`, permission modes).
Everything below is where it still does not. Dispositions: **delete**,
**re-scope** (key by workspace/harness/machine), **move** (to the runtime or
control plane that owns it).

## A. One server

| finding | where | why it is wrong now | correct owner | disposition |
| --- | --- | --- | --- | --- |
| One `active` server; `url`, `healthy`, `isLocal` describe it; every query key is built from that one base URL | `app/connection/server.tsx:216-336`, `platform/query/keys.ts` | "Is the server up" says nothing about the workspace on screen; a teammate's host going offline is invisible here while the app shows connected | The control-plane/sidecar connection only; per-workspace reachability is `workspace-connection.ts` | re-scope: rename to what it is, forbid UI from reading it for workspace state |
| One event stream re-pointed at the "live" session | `app/providers/global-sdk/provider.tsx:273`, `global-sdk-event-fetch.ts:61-155` | Only the focused session gets push; every other open workspace falls back to invalidation and refetch | One subscription per open workspace, keyed by placement | re-scope (plan 149 step 3) |

## B. Globals at boot

| finding | where | why it is wrong now | correct owner | disposition |
| --- | --- | --- | --- | --- |
| `/api/claxedo/bootstrap` aggregate seeds path, projects, providers, provider auth, config under server-only keys | `app/boot/data/bootstrap.ts:259-289`, hosted route `shell.ts:755` | On the hosted plane `provider`, `provider_auth`, `config`, `config_providers` are stubs; `project` is one of three writers of the catalog; `auth` duplicates the descriptor | Catalog (plan 149); per-workspace directory bootstrap for the rest | delete on hosted; daemon keeps at most a loopback convenience that writes no catalog |
| `["global", url, "config"]` written by bootstrap and global-sync, read by Settings → Providers and the custom-provider dialog; disconnect PATCHes `/global/config` | `bootstrap.ts:289,318`, `global-sync/provider.tsx:129`, `settings/ui/providers.tsx`, `dialogs/custom-provider.tsx`, `provider-settings-logic.ts:62-77` | Hosted `/global/config` is `{}` and has no PATCH route; the real config is the harness runtime's file per workspace | workspace + harness | move: config reads and writes go to the workspace's runtime |
| Global bootstrap seeds the provider catalog and auth for whatever single `harnessType` the boot ran with | `bootstrap.ts:223-244`, `bootstrap-orchestrator.ts:154-160` | N workspaces on N machines run different harnesses and differently configured same harnesses | workspace + harness | delete the global seed; `bootstrapDirectory` already scopes correctly |
| Directory bootstrap fans out provider, agents, path, commands, vcs per opened directory | `bootstrap.ts:389-676` | Correctly scoped, but linear in expanded workspaces and duplicated by the rail's own reads | workspace | keep; fold into plan 148's one-call session open |

## C. Catalogs, auth, config, commands

| finding | where | why it is wrong now | correct owner | disposition |
| --- | --- | --- | --- | --- |
| `providerAuth(baseUrl, harness)` has no workspace or machine | `keys.ts:38-40`, `control-plane.ts:154-173`, `provider-connect-form.tsx:45` | Two machines answering the same harness share one auth entry; the daemon's auth shows for a cloud workspace | workspace + harness (the machine serving it) | re-scope |
| Unqualified `providers(baseUrl)` key and `useProviders()` defaulting to `opencode` outside an SDK scope | `control-plane.ts:99-152`, `use-providers.ts:69-98` | First workspace's catalog reused for every context without a directory; "no harness" silently means OpenCode | workspace + harness, no default | delete the fallback; callers pass both |
| `directory.config` and `shell.commands` keys lack the workspace component `agents` and `fileStatus` got | `keys.ts:43,52-53`, `query/directory.ts:55-83`, `query/shell.ts:34-65` | Same bug class already fixed for siblings: a query fired before workspace resolution serves a stale answer forever | workspace | re-scope |
| Commands and agent profiles assume OpenCode; `harnessUsesAgentProfiles(undefined)` is true | `query/directory.ts:37-39`, `query/shell.ts` | The composer shows OpenCode's command list under any harness | workspace + harness | re-scope; unknown harness is unknown, not OpenCode |
| Settings → Providers and → Models hard-wired to `opencode` and `pi`; the tab section is labelled "Server" | `settings/ui/providers.tsx:64-65`, `settings/ui/models.tsx:154`, `dialogs/settings.tsx:120-130` | claude-sdk, codex-app-server, cursor-sdk and `acp:*` have no catalog surface; "Server" is the wrong noun | workspace + harness, chosen in the dialog | move: Settings picks a workspace and harness explicitly |
| `/provider` on the hosted plane answers only `harness=pi` | `shell.ts:805-813` | Everything else is an empty stub the client caches as a real catalog | runtime of the workspace | move (client) / delete stub (server) |

## D. Harness and model persistence

| finding | where | why it is wrong now | correct owner | disposition |
| --- | --- | --- | --- | --- |
| One draft default `{harness, model}` per workspace | `harness/draft-defaults.ts:16-36` | Switching harness overwrites the model chosen for the other; no per-harness slot | (server, workspace, harness) | re-scope |
| Harness-config request keys are pane/directory scoped, not server scoped | `harness/store-policy.ts:110-144`, `harness-query-cache.ts:55-124` | Two servers exposing the same directory string share hydrate and prepared-session entries | (server, directory, workspace, harness, session), as `session-capabilities-query.ts` already does | re-scope to that shape |
| Global model store: visibility, recent, variant in one bucket; fed by the OpenCode catalog only | `providers/models.tsx:53-137`, `Persist.global("model")` | Follows the user across machines and workspaces and never sees non-OpenCode models | (workspace, harness) for visibility and variant; recent can stay per user but must carry harness | re-scope |
| Flat legacy keys `claxedo:runner`, `claxedo:acp-model`, `claxedo:agent-mode`; maps keyed by pane scope only | `harness-preferences.ts:8-64`, `preferences/pane.ts:19-20` | Migration sources that still seed every scope | delete once draft defaults are per harness | delete |
| One `DEFAULT_HARNESS_MODEL` sentinel labelled "Default (recommended)" for every harness | `harness/profile.ts:17,52-69` | Each harness resolves its own default server-side; the client cannot say which | runtime answers the resolved default per (workspace, harness) | move: the picker shows the resolved model, the sentinel stays a wire value only |

## E. Machines

| finding | where | why it is wrong now | correct owner | disposition |
| --- | --- | --- | --- | --- |
| Extensions marketplace and machine scan go to `getClaxedoServerUrl()`; `scope=machine` has no workspace id on the wire | `extensions/marketplace/panel.tsx:43-67,117-386`, `marketplace/api.ts:219-230` | On the web the control plane cannot reach any machine; on the desktop a cloud pane scans the laptop | the workspace's runtime (machine scope = the machine serving that workspace) | move: route through placement like `http-backend.ts` |
| Process diagnostics dialog always shows the desktop's own OS | `preload/index.ts:80-137`, `dialog-process-diagnostics.tsx:20-56` | Opened from a cloud or teammate pane it shows unrelated numbers | the machine serving the focused workspace, or an explicit "this device" surface outside workspace panels | re-scope or relabel |
| Documents API always central, including content and conflict routes for repository-backed documents | `documents/data/documents-api.ts:80-93,184-226` | If the control plane does not proxy to the owning workspace, repository documents on a remote machine read the wrong place | owning `workspace_id`'s runtime | confirm server behaviour, then move if unproxied |

## Order of execution

1. Plan 149 step 1 (catalog owner) and B: delete the hosted bootstrap, the
   global provider/auth seed, and the `/global/config` surface.
2. C and D re-scopes as one change to `platform/query/keys.ts` and the
   harness persistence shapes: every key that can differ by workspace or
   harness carries both; every "no harness ⇒ opencode" default is removed.
3. Settings → Providers/Models become workspace + harness surfaces.
4. E: marketplace and diagnostics route through placement; documents after
   the server check.
5. Re-run plan 148's verification and the app's architecture ratchets; add a
   ratchet that forbids new query keys under `["global", …]` and new
   `getClaxedoServerUrl()` call sites outside the placement resolver.

## Execution log

- 2026-09-02 E (machines), `a41b2363fa`: marketplace requests resolve the
  focused workspace's placement through one transport owner
  (`features/extensions/marketplace/transport.ts`); machine scope carries the
  workspace id on the wire. Deferred, with its owner named: a remote host does
  not serve machine-scope extension management over a per-workspace relay
  token, because the host tunnel deliberately denies `/api/claxedo/*` (those
  routes describe the machine, and a relayed request would inherit loopback
  trust). Offering it needs its own authorization, most likely the owner's
  device channel that Settings → Devices already uses, not the workspace
  relay; owner: the relay role model / `user-hosted-surface.ts`. Diagnostics
  dialog relabelled "This device". Documents: repository-backed documents are
  local to the backend that indexes them by construction (`backends/local/
  backend.ts:130-137`, `hosted/managed.ts:234-238`), so no client routing
  change; agent-open and conflict routes are already relay-proxied.
