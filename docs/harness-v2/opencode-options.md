# OpenCode hosting options: the facts behind decision 2

Outcome (owner, 2026-09-25): OpenCode runs through its v2 server; see the plan's decision 2.

Date: 2026-09-25. Machine: macOS arm64 (Darwin 25.6.0), bun 1.3.14. OpenCode CLI 1.18.32 at
installed from opencode.ai (144 MB bun-compiled Mach-O). Claxedo branch `feat/harness-v2` at `8e93e73db5`, pinned
`@opencode-ai/sdk 0.0.0-beta-18684` (`packages/workspace-runtime/package.json`).

The research kept these beside the report, outside the repository; the findings below quote what matters from them:

- `openapi.json`: `GET /doc` of `opencode serve` 1.18.32 (162 paths).
- `upstream-v1.18.32-sources.md`: verbatim upstream source at tag `v1.18.32` for every function quoted below.
- `raw-outputs.md`: every experiment's raw output, in order, with timestamps.
- `exp/`: scripts (`hold-server.ts`, `sdk-rebind.ts`, `acp-handshake.ts`, `env.sh`), event streams
  (`global-events.log`, `events-A.log`, `events-B.log`), responses (`*.json`), `sdk-rebind.log`, `acp-handshake.log`.
- `server-1.log` (server under test, `--log-level DEBUG`), `server-cold.log`, `binary-strings.txt` (strings of the CLI binary).

Labels: FACT = read in source at the stated version, or observed in an experiment here. INFERENCE = reasoning
from facts. UNKNOWN = could not be determined, with the blocker named.

---

## Direct answer

**Can a shared `opencode serve` (1.18.32) give each session its own provider credentials without disturbing other sessions?**

Only in this narrow form, and only for credentials declared before the turns start:

- FACT: credentials live in the per-directory *instance* (the `Provider` state built from config + `auth.json` + env when
  the instance is created), never in a session. A prompt chooses a provider entry by `model.providerID` (per message on
  the v1 API, per session on the `/api` V2 API). Two provider entries with two different `options.apiKey` values in one
  directory's `opencode.json` ran two sessions concurrently, each request carrying its own key
  (`Bearer placeholder-a` / `Bearer placeholder-b`, raw-outputs Phase 3c-a).
- FACT: every supported way to *change* the credential set disturbs running turns or does nothing:
  `PATCH /config?directory=X` disposes X's instance after the response and aborted X's in-flight prompt at the exact
  moment of the PATCH (`MessageAbortedError`, `session.idle`, `server.instance.disposed`), while a prompt in directory
  Y kept streaming (Phase 3b). `PATCH /global/config` disposes every instance and aborted the prompt in Y
  (`global.disposed`, Phase 3c-c). `PUT /auth/{providerID}` writes `auth.json` and is invisible to a live instance
  (the next prompt went out with no `Authorization` header at all; only after `POST /instance/dispose` did it carry the
  new key, Phase 3c-b).
- FACT: `PATCH /config?directory=X` at 1.18.32 writes `<X>/config.json`, a file the loader never reads (it reads
  `opencode.jsonc`/`opencode.json` walking up from the directory: `ConfigPaths.files`). The written provider never
  appeared in `/config/providers` (Phase 2). The working per-directory path is a plaintext `opencode.json` in the
  project directory plus `POST /instance/dispose` (Phase 3a).
- INFERENCE: for Claxedo's rule "per (sender, provider) account" on a shared server, each (sender, provider) pair would
  be one provider entry (`<vendor>--<sender>` with `npm` + `models` declared, `options.baseURL` = broker,
  `options.apiKey` = that sender's placeholder) in the directory's `opencode.json`, selected per turn by `providerID`.
  Every new sender, revoked account or placeholder renewal is a config rewrite + instance dispose, which aborts every
  running turn in that directory (or, via the global file, on the whole server). There is no per-session or
  per-request credential channel in the API (section 4).

The embedded SDK is different on exactly this axis: `bindProviders` (a plugin `catalog.transform` + `catalog.reload()`)
re-bound the placeholder in 838 ms with the in-flight turn untouched, and the next turn in the *same* location went out
on the new key (Phase "SDK re-bind", raw-outputs). But Claxedo's binding today is one overlay set per process, keyed by
provider id, so it is one account per provider per process, not per sender (section 1.1).

---

## 1. What the embedded SDK gives Claxedo today

### 1.1 Provider credentials: Claxedo builds it on the plugin catalog; it is process-wide, not per session or per turn

FACT (`packages/workspace-runtime/src/opencode/provider-binding.ts`):

- Lines 44-60: `createProviderBindingPolicy` keeps `overlays: Record<providerID, {baseURL, apiKey} | unavailable>` and
  registers a plugin whose `context.catalog.transform(draft => draft.provider.update(providerID, p => p.settings = {…, baseURL, apiKey}))`
  rewrites the engine's catalog row. An unavailable overlay sets `provider.activation = "disabled"`.
- Lines 24-42 (comment) and 112-120: values are broker placeholders, never vendor secrets; they go "through the
  catalog rather than the SDK's credential store"; `apply(next)` replaces the whole set and runs `catalog.reload()` +
  `settle()` in every location the plugin was set up for. `settle` re-registers the transform last if a config file's
  `apiKey`/`baseURL` overwrote the placeholder (engine applies transforms in registration order).
- The plugin's `setup(context)` runs once per *location* (`context.location.directory`; `launch-policy.ts` lines 79-89
  and `provider-policy.ts` lines 31-70 key their stores by it), so the overlay set is shared by all locations.

FACT (`packages/claxedo-server-core/src/opencode/sdk-credential-bridge.ts`):

- Lines 23-28: "The engine is one process serving every workspace, so its bindings name that process rather than a
  workspace." Line 245: `projectRuntimeAuth({ scope: "local", orgId?, workspaceId: ENGINE_RUNTIME })`.
- Lines 254-265: one overlay per engine provider id (`anthropic`, `openai`, `openrouter`, `google`, `groq`, `xai`,
  plus each custom provider), `apiKey: projection.placeholder`, `baseURL: projection.baseUrl + apiPath`.
- Lines 110-120: `renewal` is a single `{org, at}`: "`bindProviders` installs a single overlay set, so exactly one org's
  accounts are in force". Lines 281-282: `runtime.defineProviders(custom…)` then `runtime.bindProviders(overlays)`.
- Lines 65-90: the vendor env vars are deleted from `process.env` for bound providers so the engine's env tier cannot
  substitute the operator's real key for the placeholder.

FACT (`packages/claxedo-server-core/src/opencode/sdk-runtime.ts` lines 18-26, 35-40, 61-72): the reconcile runs once
per engine boot (`bindEngineOnce`, triggered by a plugin `setup`), `databasePath` = `<dataDir>/opencode-runtime/opencode.db`.

FACT (`packages/workspace-runtime/src/opencode/harness-adapter.ts` lines 475-497): a turn waits for
`runtime.providersBound()`, refuses if `providerUnavailableReason(input.model.providerID)`, then `switchAgent`,
`switchModel({providerID, modelID, variant})`, `sessions.prompt(...)`. Nothing sender-specific reaches the engine.

INFERENCE: with the embedded SDK today, two senders sharing one session both run on the same placeholder for a given
provider (the process's one selected account). The SDK mechanism could carry N provider rows per location (the
catalog is per location and rebuilt live), but that would be new Claxedo code, and `switchModel` is per session, so two
senders alternating on one session would have to switch the session's provider row before each turn (race with
`steer`/`queue` delivery: UNKNOWN, not tested).

Is it an SDK feature? FACT: the SDK offers `catalog.transform`/`catalog.reload`/`catalog.provider.get` per location
(`@opencode-ai/plugin/dist/promise/plugin.d.ts`: `Context.catalog: CatalogDomain`, plus `integration`, `mcp`, `skill`,
`storage`, `event`, `location`). There is no per-session or per-request provider overlay in the SDK's client types:
`SessionPromptInput` has `sessionID, id?, text, files?, agents?, skills?, metadata?, delivery?, resume?` and no model
(`@opencode-ai/client/dist/promise/generated/types.d.ts` line 4952; also `session-port.ts` lines 15-19).

### 1.2 What feeds Models/Providers, and who consumes it

FACT:

- `catalog-port.ts` lines 97-116: `models(scope)` = `client.model.list({ location: { directory } })` projected to
  `{providerID, id, name?, variants?, cost[]}`; `agents`/`commands` likewise. The port never returns an empty catalog
  when the SDK is unavailable (it throws, lines 1-12).
- `packages/claxedo-server-core/src/credentials/opencode-provider-catalog.ts` lines 1-18: "provider.list returns 500 on
  an embedded host, whose default workspace driver is `registryNode({})`, an empty provider registry", so Claxedo owns the
  catalog: models.dev (`https://models.dev/api.json`, cached 24 h at `<dataDir>/opencode-model-catalog.json`), overlaid
  with the org's custom providers (`mergeCustomProviders`, lines 338-356), then `withEngineModels` (lines 291-329) marks
  `connected`/`free`/`variants` from what the running engine lists (`engineModels`, read under the engine's own
  directory: `sdk-runtime.ts` lines 52-58 `openCodeEngineModels`).
- `provider-definition.ts` lines 25-63: declares custom providers to the engine through `integration.transform`
  (env method) and `catalog.transform` (`package = "aisdk:@ai-sdk/openai-compatible"`, `settings.baseURL`, headers,
  models). `provider-policy.ts` lines 27-71: `disabled_providers` per location persisted in plugin `storage`
  (`disabled-providers:<directory>`) and enforced as `activation = "disabled"`.
- Consumer route: `packages/claxedo-local-server/src/agent-config/routes/provider-routes.ts` lines 44-59
  `GET /providers?nativeHarness=opencode` → `opencodeProviderCatalog({ org, engineModels: openCodeEngineModels })`;
  lines 60-77 `GET /providers/auth`; lines 85-111 `PUT /providers/custom` → `putCustomProvider` +
  `syncCredentialsToSdk(org, [providerID])`. The mount prefix of this router and the app-side reader were not traced.
- UNKNOWN: no caller of `runtime.providerConfig(scope)` (the `disabled_providers` store) outside `src/opencode` was found
  by the searches run (module names `createProviderPolicy`/`provider-policy` were grepped, not `providerConfig(`).

### 1.3 Is the SDK's engine the same code as `opencode serve`?

FACT:

- Same monorepo, different packages: `@opencode-ai/sdk` (`repository.directory: packages/sdk`) depends on
  `@opencode-ai/{core,server,client,plugin,schema,util}@0.0.0-beta-18684` + `effect 4.0.0-rc.112`; the CLI is
  `packages/opencode`. `@opencode-ai/sdk@0.0.0-beta-18684` was published 2026-08-29; `opencode-ai@1.18.32` on 2026-09-21;
  the SDK's `beta` tag is now `0.0.0-beta-19271` (2026-09-07), `dev` is `0.0.0-dev-202609241927`.
- The npm name carries two products: `@opencode-ai/sdk@1.18.32` (`latest`; deps `cross-spawn`; exports `.`, `./v2`,
  `./client`, `./server`) is the generated HTTP client for `opencode serve`, which the CLI's own ACP command imports
  (`createOpencodeClient` from `@opencode-ai/sdk/v2`, `cli/cmd/acp.ts`). The `0.0.0-beta-*` line is the embeddable
  engine Claxedo pins (`OpenCode.create`).
- The embedded SDK runs the V2 server router in-process: `dist/internal/host.d.ts` (`createEmbeddedRoutes` from
  `@opencode-ai/server/routes`, an Effect `ManagedRuntime`, an owned `fetch` from `dist/internal/fetch.d.ts`, no TCP).
- `opencode serve` 1.18.32 is the v1 engine in `packages/opencode/src/{session,provider,config,server}` (e.g.
  `session/prompt.ts` ~2,350 lines, `provider/provider.ts` 1,447 lines), which imports some `@opencode-ai/core` library
  modules (`database/*`, `flag`, `global`, `fs-util`, `event`, `provider` ids). Its `/api/*` routes are its own
  "Experimental HttpApi surface for selected instance routes" (binary string; `routes/instance/httpapi/`), not the V2
  server: the binary has 0 occurrences of `session.inbox.enqueued`, `session.usage.recorded`,
  `/api/session/:sessionID/inbox` and `SdkPlugins`, while the pinned `@opencode-ai/core` dist ships
  `session/{execution,inbox,runner,run-coordinator,...}`.
- Concrete drift on the same route name: the CLI's `POST /api/session/{id}/prompt` body is
  `{id?, prompt: {text, files?, agents?}, delivery?, resume?}`; the pinned SDK's is flat `{text, files?, agents?, skills?,
  metadata?, delivery?, resume?}`. The SDK shape was rejected with 400 `Missing key at ["prompt"]` (Phase 4c). CLI V2
  events are `session.next.*` (40 names); the SDK's are `session.step.*`, `session.execution.*`, `session.inbox.*`,
  `session.usage.*`. Unknown `/api/...` paths on the CLI return the web UI's HTML with 200 (catch-all), so a missing
  route looks like success unless the content type is checked.

INFERENCE: the pinned SDK and `opencode serve` 1.18.32 are two engines from one repository, converging but not the same
code; a client written against one does not run against the other without an adapter.

### 1.4 The SDK's API shape (pinned beta-18684)

FACT (`@opencode-ai/sdk/dist/{index,promise,internal/host}.d.ts`, `@opencode-ai/server/dist/options.d.ts`):
`OpenCode.create(options?: CreateOptions, embed?)`, `CreateOptions` = `ServerOptions` minus hostname/port/password, plus
`plugins` and `log`: `database.path`, `events.persist`, `config.{directory,project,file,content}`,
`models.{url,file,fetch,snapshot}`, `fs.{fff,filewatcher}`, `simulation`, `app`. Claxedo passes `plugins`,
`database.path`, `events.persist`, `fs.fff: false`, `config.content` (`host.ts` lines 94-110). `Interface` =
`OpenCodeClient` with `sessions`/`events` aliases and `close()`. Protocol groups: agent, command, config, credential,
debug, event, form, fs, generate, health, integration, location, mcp, message, migration, model, permission,
persistent-pty, plugin, project, provider, pty, reference, server, session, shell, skill, vcs, websearch, workspace.
Session operations Claxedo uses (`session-port.ts`): `create({location:{directory}, id?, title?})`, `get({sessionID})`
(no authorization: `scope.ts` lines 3-9), `list({directory, limit, cursor})`, `rename`, `remove`, `fork({boundary})`,
`switchAgent`, `switchModel({model:{providerID,id,variant}})`, `prompt`, `command`, `interrupt`, `revert.stage/clear`,
`message.list`; `permission.request.list/reply`, `form.request.list/reply/cancel`; `events.subscribe({signal})` yields
`{id, type, location?, durable?: {aggregateID, seq}, data}` (`event-pump.ts`).

---

## 2. The HTTP server's API at 1.18.32 (`openapi.json`)

### 2.1 Prompt endpoints

FACT:

- `POST /session/{sessionID}/message` (sync) and `POST /session/{sessionID}/prompt_async` (204): query `directory`,
  `workspace`; body `{messageID?, model?: {providerID, modelID}, agent?, noReply?, tools?: {name: bool}, format?,
  system?, variant?, parts: [Text|File|Agent|Subtask]}`. `model` is per message. Nothing per message about credentials or
  provider options. Precedence in `session/prompt.ts`: `input.model ?? agent.model ?? currentModel(sessionID)`.
- `POST /session/{sessionID}/command`: `{command, arguments, agent?, model?: string, variant?, parts?}`.
- V2: `POST /api/session/{sessionID}/prompt` `{id?, prompt:{text,files?,agents?}, delivery?: steer|queue, resume?}`
  (no model); `POST /api/session/{sessionID}/model` `{model: ModelRef}`; `POST /api/session` `{id?, agent?, model?,
  location?: {directory, workspaceID?}}`. V1 and V2 share one session table (a V2-created id answered v1
  `GET /session/{id}`, Phase 4c).

### 2.2 How credentials are supplied and their scope

FACT:

| Source | Endpoint / file | Scope | When a live instance sees it |
|---|---|---|---|
| `PUT /auth/{providerID}` body `OAuth \| ApiAuth{type:"api",key,metadata?} \| WellKnownAuth` | writes `$XDG_DATA_HOME/opencode/auth.json` (`auth/index.ts`: `Global.Path.data/auth.json`, mode 0600); `DELETE` removes | server-global, keyed by provider id; no directory or session | never, until that directory's instance is (re)created: Phase 3c-b sent no `Authorization` header before dispose, `Bearer auth-key-d` after |
| `OPENCODE_AUTH_CONTENT` | replaces the whole auth map (`Auth.all`) | process | at instance creation |
| `provider.<id>.options.{apiKey,baseURL,headers?,timeout,...}`, `provider.<id>.{npm,api,env,models,whitelist,blacklist}`, `disabled_providers`, `enabled_providers` | `opencode.jsonc`/`opencode.json` found walking up from the directory to the worktree root (`ConfigPaths.files`); global `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`; `OPENCODE_CONFIG=<file>` (extra file); `OPENCODE_CONFIG_CONTENT=<json>` ("final local-scope merge") | per directory instance for project files; process for env and global files | at instance creation; `PATCH /global/config` disposes all instances; `POST /instance/dispose?directory=` one |
| env vars named by `provider.env` | process env | process | at instance creation (`source: "env"`) |

Precedence (FACT, `provider.ts` `resolveSDK`: `if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key`;
Phase 3c-b2): config `options.apiKey` beats an `auth.json` key; env keys fill `provider.key` only when the provider
lists exactly one env var. SDK clients are cached per instance by hash of `{providerID, npm, options}`; language models
per `${providerID}/${modelID}`.

### 2.3 Config endpoints

FACT:

- `GET /config?directory=` returns the merged config of that directory's instance (the `provider` key was absent/null in
  every read here, even after providers were loaded; `/config/providers` is the readable list).
- `PATCH /config?directory=` (`config.update`): `Config.update` writes `path.join(InstanceState.directory, "config.json")`
  (merge-deep into that file), then `markInstanceForDisposal(ctx)`; `disposeMiddleware` disposes the instance after the
  response is sent. The file it writes is not one the loader reads (section "Direct answer"). Response echoes the payload.
- `GET /global/config`, `PATCH /global/config` (`global.config.update`): `Config.updateGlobal` writes
  `globalConfigFile()` (observed: `~/.config/opencode/opencode.jsonc`), and if the text changed forks
  `disposeAllInstancesAndEmitGlobalDisposed` (every instance disposed, `global.disposed` emitted).
- `POST /instance/dispose?directory=` (one instance), `POST /global/dispose` (all).
- `GET /config/providers?directory=` → `{providers: [public provider info], default: {providerID: modelID}}`.
- No `config.updated` event exists in the 1.18.32 event union; the observable signals are `server.instance.disposed
  {directory}` (per-directory and global streams) and `global.disposed`.

### 2.4 Provider / catalog endpoints

FACT: `GET /provider?directory=` → `{all: [{id, name, source: "custom"|"config"|..., env, options, models}], connected,
default}` (6.4 MB here: full models.dev plus config providers, `options` includes the plaintext `apiKey`);
`GET /provider/auth`; `GET /config/providers`; V2 `GET /api/provider`, `GET /api/provider/{id}`,
`GET /api/model?location[directory]=` → `{location, data: [{providerID, id, ...}]}` (listed the config providers,
Phase 4c). This `/api/model` is the same operation the embedded `catalog-port.models()` calls (`model.list({location})`),
so the "which models can run" signal Claxedo derives from the engine exists on the server too; the models.dev overlay and
custom-provider merge are Claxedo's own and would be unchanged. V2 credential store: `GET /api/integration`,
`POST /api/integration/{id}/connect/key {key,label?}`, `PATCH|DELETE /api/credential/{id}` (with `location`).

### 2.5 Session, history, commands, permissions, questions, events

FACT: v1 `GET|POST /session`, `GET|PATCH|DELETE /session/{id}`, `/session/{id}/children`, `/message` (GET list with
`limit`/`before`; POST prompt), `/message/{messageID}`, `/prompt_async`, `/command`, `/abort`, `/fork`, `/revert`,
`/unrevert`, `/summarize`, `/todo`, `/diff`, `/shell`, `/share`, `/init`, `/session/status`; `GET /command?directory=`;
permissions `GET /permission?directory=`, `POST /permission/{requestID}/reply {reply: once|always|reject, message?}`,
legacy `POST /session/{id}/permissions/{permissionID} {response}`; questions `GET /question`,
`POST /question/{requestID}/reply {answers}`, `/reject`. V2: `/api/session/{id}/history` (durable `session.next.*`
events, `limit`/`after`), `/context`, `/permission` (list/create), `/permission/{requestID}/reply`, `/question`, `/wait`,
`/interrupt`, `/compact`, `/event`; `/api/agent`, `/api/command`, `/api/skill`, `/api/location`.
Events: `GET /event?directory=` (per-directory SSE; subscribing creates the instance: "creating instance" was logged at
the subscribe, Phase 1), `GET /global/event` (every directory, `{directory, project, workspace, payload}`, `server.connected`
first, `server.heartbeat` every 10 s), `GET /api/event`. Server auth: `OPENCODE_SERVER_PASSWORD` (basic); the server
prints "server is unsecured" without it.

---

## 3. Does a config/provider change disturb other sessions?

### 3.1 Source (v1.18.32; full quotes in `upstream-v1.18.32-sources.md`)

FACT, the chain for `PATCH /config?directory=X`:

1. `handlers/config.ts`: `yield* configSvc.update(ctx.payload); yield* markInstanceForDisposal(yield* InstanceState.context)`.
2. `lifecycle.ts`: `markInstanceForDisposal` stores the instance in a `WeakMap` keyed by the request; `disposeMiddleware`
   runs `store.dispose(marked.ctx)` after the response ("The response is sent before disposeMiddleware performs the teardown").
3. `project/instance-store.ts`: `dispose` → `disposeContext` → `runDisposers(ctx.directory)` → emits
   `server.instance.disposed {directory}`; the store is a `Map` keyed by resolved directory, so only that entry goes.
4. `effect/instance-registry.ts`: `disposeInstance(directory)` runs every registered disposer.
5. `effect/instance-state.ts`: every `InstanceState.make(...)` registers a disposer that invalidates its `ScopedCache`
   entry for that directory. `Provider` state (config, models.dev catalog, SDK clients, language models) and the session
   engine's state are such caches, so the running prompt's scope is closed; `session/prompt.ts` finalises the assistant
   message with `AbortError` → stored as `MessageAbortedError`.

FACT, `PATCH /global/config`: `handlers/global.ts` `configUpdate` → `config.updateGlobal` (writes the global file,
`invalidate()`), `if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({swallowErrors: true}))`
→ `store.disposeAll()` + `global.disposed`.

FACT, `PUT /auth/{providerID}`: `handlers/control.ts` `authSet` → `auth.set(providerID, payload)` only; no
invalidation, no dispose. Provider state reads `auth.all()` once at instance creation (`provider.ts` "load apikeys").

FACT, the `directory` query parameter: `middleware/workspace-routing.ts` `defaultDirectory` =
`?directory` || header `x-opencode-directory` || `process.cwd()`; a `?workspace=` id may route the request to a remote
workspace; `middleware/instance-context.ts` calls `InstanceStore.load({directory})` per request, so the first request for
a directory creates its instance.

### 3.2 Live experiments (server 47981, holding endpoint 47990; full logs in `raw-outputs.md`)

| Step | Observed |
|---|---|
| Sessions A (proj-A) and B (proj-B); subscriptions on `/global/event`, `/event?directory=A`, `/event?directory=B` | both instances created at subscribe time; `session.created` on the right streams |
| `PATCH /config?directory=A` (add probe-a) | 200; wrote `proj-A/config.json`; `server.instance.disposed` for A on global and A streams only; B stream silent; both sessions still answer `GET /session/{id}`; `/config/providers` for A still `["opencode"]` (file not read) |
| `PATCH /config?directory=B` (probe-b) | same, scoped to B |
| `opencode.json` in A (probe-a, probe-b, probe-d) and B (probe-b) + `POST /instance/dispose` each | `/config/providers` A = opencode, probe-a, probe-b, probe-d; B = opencode, probe-b; `/provider` shows `options.apiKey` plaintext |
| `prompt_async` A with `model: probe-a/m1` | endpoint received `Authorization: Bearer placeholder-a` at 07:05:05.011; status busy; stream held open |
| `PATCH /config?directory=B` while A streams | B disposed; A's upstream request stayed open 4 s later; A still busy |
| `PATCH /config?directory=A` while A streams (07:05:13) | endpoint saw `client_disconnected` at 07:05:13.190; events `message.updated`, `session.status`, `session.idle`, `server.instance.disposed`; assistant message `error: MessageAbortedError`, `completed` set; status `{}` |
| Two sessions in A, one on probe-a and one on probe-b, concurrently | requests at 07:07:03.389 carried `placeholder-a` and `placeholder-b` respectively; both busy; `POST /abort` disconnected each within 50-115 ms |
| `PUT /auth/probe-d` (key `auth-key-d`) with A's instance alive; prompt via probe-d | `auth.json` written; no dispose event; request carried **no** `Authorization` header; after `POST /instance/dispose?directory=A` the request carried `Bearer auth-key-d` |
| `PUT /auth/probe-a` (`auth-key-a`) + dispose; prompt via probe-a | request carried `Bearer placeholder-a` (config `options.apiKey` wins) |
| Prompt streaming in B; `PATCH /global/config` (add probe-g) | wrote `~/.config/opencode/opencode.jsonc`; B's request disconnected 1.4 s later; `server.instance.disposed` for B and `global.disposed`; B's assistant message `MessageAbortedError`; both directories now list probe-g |

FACT, `/api` on the same server: `POST /api/session {location:{directory}}` works and the id is visible on v1;
`/api/session/{id}/prompt` needs `{prompt:{text}}`; `/api/session/{id}/interrupt` → 204; `/api/model?location[directory]=`
lists the config providers; unknown `/api/...` paths return the web UI HTML with 200.

### 3.3 The embedded SDK under the same test (`exp/sdk-rebind.ts`, through Claxedo's `createOpenCodeRuntime`)

FACT: host booted in 612 ms; prompt in location A went out with `Bearer sdk-key-1`; `bindProviders({proof: sdk-key-2})`
returned in 838 ms and emitted `catalog.updated`/`integration.updated` per location; A's request was **not**
disconnected; a prompt in location B and a second session in location A both went out with `Bearer sdk-key-2` while A's
first turn continued on `sdk-key-1`; no `session.execution.interrupted` until the explicit interrupts. Overlays are
process-global, so both locations received the new key (a per-location split would be Claxedo code, INFERENCE).

---

## 4. Per-session or per-request credentials inside one server; ACP

FACT (1.18.32):

- Sessions carry `model {providerID, id, variant?}`, `agent`, `permission` ruleset, `metadata`, `workspaceID`, `title`,
  `directory`; no credential, base URL or header field (`POST /session` body; `Session` schema). Messages carry `model`,
  `agent`, `tools`, `system`, `format`, `variant`; no credential field. Nothing in `Auth`, `ProviderConfig` or the routes
  takes a session id. Per-request headers select only the *directory* (`x-opencode-directory`) or workspace.
- `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG_DIR` are process environment:
  one value per server.
- Agent-level model (`agent.<name>.model`) is config, i.e. per instance; it selects a provider row, not a key.
- Provider options per message: none. Provider rows per instance: unlimited; each custom id needs `npm` and `models`
  (the ids `probe-*` worked with `npm: "@ai-sdk/openai-compatible"` and an explicit `models` map).

INFERENCE: the only supported multi-credential shape in one server is N provider rows per directory selected by
`providerID`, declared before the turns that use them; each change of the set is a file rewrite plus an instance
dispose (aborts that directory's turns) or a global rewrite (aborts everything).

`opencode acp` (option D). FACT (`cli/cmd/acp.ts`, `acp/service.ts`, and the handshake in `exp/acp-handshake.log`):

- One process per client over stdio; it starts its own in-process HTTP server (`Server.listen`) and drives it through
  the v1 client (`createOpencodeClient` from `@opencode-ai/sdk/v2`). Credentials are that process's `auth.json` /
  config / env, exactly as for `serve`.
- `initialize` → `authMethods: [{id: "opencode-login", description: "Run `opencode auth login` in the terminal"}]`;
  `authenticate` is a no-op for that id. There is no per-session credential parameter in the protocol as implemented.
- `session/new {cwd, mcpServers}` → `session.create({directory: cwd, agent?, model})` + `mcp.add({directory, name,
  config})` for each MCP server (registered on the directory instance, deduplicated per session key), returns
  `configOptions` (`model` select built from `config.providers` of that directory: the `probe-*` models appeared; `mode`
  select build/plan). `session/set_model "probe-b/m1"` was accepted and reflected in `config_option_update`.
  `loadSession`, `fork`, `list`, `resume`, `close` are advertised.

UNKNOWN: whether two ACP processes can `session/load` the same session id concurrently against the shared
`opencode.db` (not tested; the SDK host requires a single database writer per `host.ts` lines 10-12, and the CLI's
posture was not checked).

---

## 5. Cost facts

FACT (measured here, bun RSS, `ps -o rss`):

| Measure | Value |
|---|---|
| `opencode serve` cold start to `/global/health` 200 (fresh HOME, no config) | 511 ms (50 ms poll granularity) |
| Idle RSS, fresh server, 2 s / 5 s after start | 381 MB / 408 MB |
| RSS after serving `GET /doc` once | 484 MB |
| RSS after the experiments (2 instances, ~12 sessions, DEBUG logging, models.dev loaded) | 943 MB; 289 MB after `POST /global/dispose` |
| RSS per additional directory instance | +5 to +27 MB each (10 instances: 185 → 460 MB; 5 instances from a 289 MB baseline: +21, +5, +5, +4, +5 MB) |
| RSS per idle session | ~50 KB (30 sessions: +1.5 MB) |
| Embedded SDK in a bun process through Claxedo's runtime | 652 MB after boot + bind; 993 MB with 2 locations and 3 running turns (includes Claxedo's modules; the SDK's own share was not isolated) |
| Binary | 144 MB Mach-O; `--print-logs`, `--pure`, `--port`, `--hostname`, `--mdns`, `--cors` only |

FACT (source): no limit on instances or sessions. `InstanceStore` is a plain `Map` keyed by resolved directory;
`InstanceState` caches use `capacity: Number.POSITIVE_INFINITY`; sessions are SQLite rows in
`$XDG_DATA_HOME/opencode/opencode.db`. Provider state per instance holds the parsed models.dev catalog, which is the
per-instance memory above (INFERENCE from `provider.ts` state and the measured deltas).

UNKNOWN: idle RSS of `opencode acp` (not measured; it runs `Server.listen` in-process, so at least the `serve` baseline:
INFERENCE).

---

## 6. Options against the product rules

| | A: in-process SDK (today) | B: SDK in a Claxedo worker per credential profile | C: `opencode serve` | D: `opencode acp` |
|---|---|---|---|---|
| Per-sender credentials | Not today: one overlay set per process, one account per provider (FACT 1.1). Mechanism exists to carry N rows per location live (FACT 3.3), selection is per session via `switchModel` (INFERENCE, untested for two senders on one session) | Per profile by construction. A shared session whose two senders are two profiles spans two workers on one SQLite file: UNKNOWN whether two embedded hosts may share `database.path` (host.ts demands one writer) | Shared: N provider rows per directory config, chosen per message/session (FACT 3.2); adding/renewing rows aborts that directory's turns (FACT). Per profile/session: one server per profile, separate `auth.json`/db per HOME unless XDG dirs are shared (UNKNOWN safety) | Per process only (`auth.json`/config/env of the ACP process); no per-session credential API (FACT 4). Per sender = one process per sender |
| Disturbance when the credential set changes | None observed: 838 ms live re-bind, in-flight turn untouched, next turn on the new key (FACT 3.3) | Same as A inside the worker; a new profile is a new process | `PATCH /config?directory=`: aborts that directory's running turns, other directories untouched; `PATCH /global/config`: aborts every turn; `PUT /auth`: no effect until dispose (FACT 3.2) | Same engine as C inside the process; a change means restarting the process (INFERENCE) |
| Models/Providers catalog | `model.list({location})` + Claxedo's models.dev overlay (FACT 1.2) | Same per worker | `GET /api/model?location[directory]=` and `GET /config/providers` give the equivalent engine list (FACT 2.4); `/provider` leaks `options.apiKey` in its output | `session/new` `configOptions` lists the directory's models (FACT 4); no catalog route of its own |
| Crash isolation | None: engine shares the Claxedo server process (INFERENCE) | Per worker | One shared server: every session on it; per profile: that profile | Per client process |
| Memory | 652 MB bun process after boot+bind here; SDK share not isolated | one such host per profile (UNKNOWN exact per-worker cost on Node) | 380-410 MB idle + 5-27 MB per directory instance; ~1 GB after activity with DEBUG logs (FACT 5) | at least the serve baseline per process (INFERENCE) |
| Unknowns | Two senders alternating on one session with `switchModel` under `steer`/`queue` | Shared SQLite writer; Node worker cost | Placeholder renewal cadence vs abort cost; `/api` catch-all masks missing routes; per-directory `PATCH /config` writes an unread file at this version | Concurrent `session/load` across processes; idle RSS |

---

## Commands run (essentials)

- Server: `HOME=$H XDG_*=$H/... opencode serve --port 47981 --hostname 127.0.0.1 --print-logs --log-level DEBUG`
  (pid 78309); cold-start run on 47982 (pid 13840); holding endpoint `bun run exp/hold-server.ts` (pid 38042);
  SSE subscriptions via `curl -sN` (pids 47676/47678/47680). All killed by pid at the end (`raw-outputs.md`).
- `curl` against `/doc`, `/session`, `/config`, `/global/config`, `/config/providers`, `/provider`, `/auth/{id}`,
  `/instance/dispose`, `/global/dispose`, `/session/{id}/prompt_async`, `/abort`, `/message`, `/session/status`,
  `/api/session`, `/api/session/{id}/prompt`, `/api/model`, `/event`, `/global/event`.
- `bun run exp/sdk-rebind.ts` from `packages/workspace-runtime` (embedded SDK through Claxedo's runtime, throwaway HOME).
- `bun run exp/acp-handshake.ts` (`opencode acp --cwd proj-A`, JSON-RPC over stdio).
- `strings -n 12` of the CLI binary; `npm view` for registry timestamps and exports; WebFetch of raw GitHub files at `v1.18.32`.
- No repository file was edited during the research; every experiment ran under a throwaway HOME.

---

# Follow-up experiments

Raw outputs: `raw-outputs.md` sections F1-F7; scripts and logs under `exp2/` and `latest/`. Recording endpoint v2
(`exp2/hold-server2.ts`) logs every header and the full body and answers as OpenAI chat, OpenAI Responses or Anthropic
Messages streams; a body containing `HOLD` never finishes.

## FU-1. Embedded SDK: two senders alternating in ONE session

Version: `@opencode-ai/sdk 0.0.0-beta-18684` through Claxedo's `createOpenCodeRuntime` (`exp2/sdk-two-senders.ts`);
repeated on `0.0.0-beta-19271` driven directly (`latest/sdk-beta/sdk19271-two-senders.ts`, Part 1), same results.

FACT (both versions):

- Two rows for the same upstream in one location (`defineProviders` + `bindProviders({ "proof-a": sender-a, "proof-b": sender-b })`
  on 18684; a catalog-rows plugin on 19271). One session S1 ran turn 1 on `proof-a`, turn 2 on `proof-b`, turn 3 on
  `proof-a`: the requests carried `Bearer sender-a`, `sender-b`, `sender-a`. Turn 3's request body carried the whole
  conversation (`user:turn one | assistant:reply | user:turn two | assistant:reply | user:turn three`, 5 non-system
  messages); the SDK's own history for S1 is one conversation whose assistant messages each record the row they ran on
  (`assistant@proof-a`, `assistant@proof-b`, `assistant@proof-a`; `model-switched` entries in between).
- A session in another location (S2) held in flight on `proof-b` for the whole run was never disconnected; a second
  session in that location ran its own turn concurrently with S1's turn 2 (`Bearer sender-a`). Switching rows on S1
  (`switchModel` before each turn, the same call Claxedo's adapter makes) disturbed nothing else.
- Adding a third sender while a turn ran in the same location: 18684 `defineProviders` + `bindProviders` (integration +
  catalog reload in every location) took 1,853 ms; 19271 `catalog.reload()` took 25 ms. The in-flight turn in that
  location and the one in the other location both survived; a new session and S1's turn 4 then ran on `Bearer sender-c`
  (S1's request carried all 7 prior messages).

INFERENCE: with the embedded SDK the sender switch is a per-turn `switchModel` to that sender's row; the session stays
one conversation and no other session or in-flight turn is touched. The cost is one row per (sender, provider) per
location and a catalog reload when the set changes.

## FU-2. `opencode serve`: does an outbound model request identify its session?

Versions: 1.18.32 (`exp2/identity.sh 47983`) and dev `0.0.0-dev-202609241927` (`latest/dev-rerun.log` step 6); identical.

FACT: every outbound request, on all three provider packages pointed at the endpoint, carried
`x-session-affinity: <sessionID>` and `X-Session-Id: <sessionID>` (plus `x-parent-session-id` for subagent sessions
per source; not exercised). The OpenAI Responses body (`@ai-sdk/openai` posts to `/responses`) also carried
`prompt_cache_key: <sessionID>` and `store: false`; `@ai-sdk/openai-compatible` (chat completions) and `@ai-sdk/anthropic`
(`/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: structured-outputs-2025-11-13`) carried no
body-level identifier (`user`, `metadata`, `safety_identifier` all absent). `User-Agent` is
`opencode/<version> ai-sdk/provider-utils/<n> runtime/bun/1.3.14`. The value is the same on every turn of a session
(C1's two chat turns, #13 and #19) and differs per session (C1 vs C2).

FACT (source, v1.18.32): the headers come from `packages/core/src/session/runner/llm.ts`
(`http: { headers: { "x-session-affinity": session.id, "X-Session-Id": session.id, ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}) } }, providerOptions: { openai: { promptCacheKey } }`)
and, on the legacy path, `packages/opencode/src/session/llm/request.ts` (same names; `x-opencode-session` /
`x-opencode-request` for the `opencode*` providers). The binary carries the same code. Documentation: upstream PR #20744
and issue #42694 (regression in 1.18.16/1.18.18, fixed by PR #43188); no opencode.ai docs page found; third-party gateway
docs (Bifrost, LiteLLM) rely on it. Label: source-visible, shipped since 2026-04, regressed once.

INFERENCE: a broker in front of one shared server can map `X-Session-Id` to the current turn's sender (Claxedo knows
which sender's turn is running in which session) and swap in that sender's real key, with one provider row per server
and no config churn. Caveats: the mapping is per session, so the broker must be told which sender owns the *current*
turn before the turn's first request (steer/queue deliveries inside a turn belong to the same turn); `prompt_cache_key`
is the session id, so two senders alternating in one session share a prompt-cache key at OpenAI (cost only);
subagent requests carry the child session id, with the parent in `x-parent-session-id`.

---

# Latest builds

Installed in isolation under `latest/` (`npm i --prefix ... --ignore-scripts`; nothing touched `~/.opencode` or the repo):
`opencode-ai@0.0.0-dev-202609241927` (+ `opencode-darwin-arm64` 144.75 MB, run directly),
`@opencode-ai/sdk@0.0.0-dev-202609241927`, `@opencode-ai/sdk@0.0.0-beta-19271` (493 MB with dependencies).

## Which engine each one runs

- FACT: dev `opencode serve` (`0.0.0-dev-202609241927`, version string confirmed by `/global/health`) is the v1 engine
  with the experimental `/api` routes, exactly as 1.18.32: `GET /doc` has the same 162 paths (0 added, 0 removed), the
  same 40 `session.*` event names (`session.next.*`), the same prompt/session/config/auth bodies, the same `serve --help`;
  binary markers identical (0 × `session.inbox.enqueued`, 0 × `SdkPlugins`, 0 × `/api/session/:sessionID/inbox`,
  1 × `@opencode/InstanceStore`, 3 × `session.next.step.started`), and `Config.update` still writes `<dir>/config.json`.
- FACT: `@opencode-ai/sdk@0.0.0-dev-202609241927` is the HTTP client line (deps: `cross-spawn`; `createOpencode()`
  spawns a server with cross-spawn and waits for "opencode server listening"; exports `./v2` client/server/types).
  It is not the in-process SDK; there is no `OpenCode.create`.
- FACT: `@opencode-ai/sdk@0.0.0-beta-19271` is the in-process V2 SDK (deps `@opencode-ai/{core,server,client,plugin,schema,util}@beta-19271`,
  `effect 4.0.0-rc.112`; `OpenCode.create(options)`), the newest of Claxedo's line (published 2026-09-07).
- FACT: Claxedo's `packages/workspace-runtime/src/opencode/*.ts` (tests excluded) typechecks against beta-19271 with
  0 errors (TypeScript 7.0.2, path overrides verified with `--listFiles`: 753 files from the beta-19271 install, 0 from
  the pinned packages; control run against the pinned SDK also 0 errors). Surface changes: `CatalogDraft`→`CatalogEditor`,
  `IntegrationDraft`→`IntegrationEditor` (invisible to Claxedo's `Parameters<>`-derived types), `Context.plugin` narrowed
  to `list`, new `Context.rpc`/`Context.worktree`, `Plugin` without `tui`/`vcs`. UNKNOWN: runtime behaviour of the
  launch policy's `mcp`/`skill` transforms on 19271 (their d.ts changed; only typechecked, not executed).
- FACT, new in beta-19271: `CreateOptions.instances?: { key: (session: Session.Info) => string; configure: (key) => { plugins } }`
  ("Select a sharing key within the Session's current Location. Must not initialize plugins." /
  "Reconstruct configuration on a cache miss, including after a host restart."). `sdk/dist/internal/instances.js`
  keys a `LayerMap` of instances by `{ key(session), ...canonical(session.location) }` with `idleTimeToLive: infinity`,
  so sessions of one location are partitioned into instances with their own plugin sets.
- FACT (beta-19271, `sdk19271-modellist.ts`): `model.list({location})` returned 0 rows immediately after a location's
  first use and 9 rows (plugin rows included) 1.5 s later; `provider.list` showed the plugin's row with `activation:
  enabled` and `settings.apiKey`. Turns on the row succeeded from the start. INFERENCE: the model list is filled
  asynchronously (models.dev refresh); a catalog read right after first use can be empty on 19271.

## First-round findings re-run on the dev nightly serve (`latest/dev-rerun.log`, `latest/dev-auth-live.log`)

| Question | 1.18.32 | dev-202609241927 |
|---|---|---|
| `PATCH /config?directory=` writes a file the loader reads? | No: `<dir>/config.json`, provider absent from `/config/providers` | No: same file, same result |
| Directory config change disposes the instance and aborts its in-flight prompts? | Yes (`server.instance.disposed`, `MessageAbortedError`); other directory untouched | Yes, identical (#20/#21 disconnected on PATCH A, none on PATCH B) |
| Global config change? | Disposes all, aborts every turn (`global.disposed`) | Identical (#25 disconnected, `global.disposed`) |
| `PUT /auth` inert until dispose? | Yes | Yes (live instance: no `Authorization`; after dispose `Bearer auth-key-e`); config `options.apiKey` still beats `auth.json` |
| Per-session / per-request credential channel? | None | None (same OpenAPI bodies, no new headers) |
| Two provider rows serve concurrent sessions with the right keys? | Yes | Yes (`placeholder-a` / `placeholder-b`) |
| Outbound request identifies its session? | `x-session-affinity`, `X-Session-Id`, Responses `prompt_cache_key` | Identical |
| Cold start / idle RSS | 511 ms / 381-408 MB | 574 ms / 417 MB (199 MB after the run, INFO logs) |

Side observation (FACT): the dev build wrote `package.json` (`@opencode-ai/plugin@0.0.0-dev-202609241927`),
`package-lock.json` and `node_modules` into the global config directory.

## Per-version summary of what changed

| | 1.18.32 / beta-18684 (baseline) | dev-202609241927 CLI | sdk dev-202609241927 | sdk beta-19271 |
|---|---|---|---|---|
| Engine | v1 CLI + experimental `/api`; SDK = V2 in-process | same v1 CLI, unchanged API and behaviour | HTTP client for the CLI (not in-process) | V2 in-process, newest |
| Config change disturbance | dispose + abort per directory / global | same | n/a (client) | live `catalog.reload()` in 25 ms, in-flight turns untouched |
| Per-sender credentials | rows per directory config; change = abort | same | same server semantics | rows per location (as 18684) **or** per-session instances via `instances.key` |
| Two senders in one session | not tested on serve (per-message `model.providerID` selects the row) | same | same | proven: alternating rows keep one history; per-session instance re-keyed by rename also keeps one history |
| Session identity on the wire | `x-session-affinity`/`X-Session-Id`(+`prompt_cache_key` for Responses) | identical | n/a | not measured for the SDK's own requests (UNKNOWN) |
| Claxedo `src/opencode` compatibility | pinned | n/a | not applicable (different product) | typechecks with 0 errors |

---

# Limitations pass: (1) SDK worker, (2) shared `opencode serve`, (3) `opencode acp`, (4) v2 server

Rulings applied: credentials follow the session's owner (they change only on connect/switch/revoke and hourly
renewal), and an SDK runs in its own worker process, one per runtime. Raw outputs: `raw-outputs.md` L1-L6.
Versions: (1) `@opencode-ai/sdk@0.0.0-beta-19271`; (2) 1.18.32 (dev nightly identical); (3) 1.18.32;
(4) `@opencode-ai/cli@0.0.0-beta-19271` (`opencode2 serve`) and `@opencode-ai/server@beta-19271` `ServerProcess.start`.

## Does upstream ship a v2 server? Yes (FACT)

- `@opencode-ai/server@beta-19271` exports `ServerProcess.start(options, lifecycle?, transform?)`: a Node
  `http.createServer` listener (hostname/port, port search from 4096), Basic auth with a **mandatory** password
  (`Missing server password` otherwise), CORS, readiness, and `installRestartContinuity(SessionRestart)` when a
  lifecycle is passed. `ServerFetch.make` is the embeddable no-listener variant (the SDK's owned `fetch`).
- `@opencode-ai/cli` (`opencode2`, "OpenCode 2.0 preview command line interface"; dist-tags latest=next=beta-17823,
  beta=beta-19271, dev daily) ships `serve` = "Start the v2 API and web server" with `--hostname --port --cors
  --service --stdio`, plus `service start|stop|status|get|set|unset`, `pair`, `api`, `acp`, `auth`, `plugin`.
  Its binary carries the v2 engine (`session.inbox.enqueued`, `SdkPlugins`, `ServerProcess`; no `session.next.*`).
  `@opencode-ai/client` `Service.ensure()` defaults to spawning `opencode serve --service` and reads
  `$XDG_STATE_HOME/opencode/service.json` (`{id, version, url, pid, password}`).
- The v1 CLIs (1.18.32, dev-202609241927, beta-202608110357) carry none of it (0 × `--service`, `ServerProcess`).
- Upstream signals: `opencode.ai/v2/docs` exists (CLI/Desktop/Docker `ghcr.io/anomalyco/opencode:2.0.0`) with no
  server/SDK pages; the v1 SDK page links "New OpenCode v2"; third-party write-ups call 2.0 "the future core; the
  CLI, the server, the runtime" with plugin/SDK contracts "still being finalized"; the changelog has no 2.0 entry.
  INFERENCE: v1 `serve` is not moving to v2; v2 is a separate binary (`opencode2`) that replaces it at 2.0.

## Comparison

| Dimension | (1) SDK worker | (2) shared `opencode serve` 1.18.32 | (3) `opencode acp` 1.18.32 | (4) v2 server (`opencode2 serve` / `ServerProcess.start`) |
|---|---|---|---|---|
| Engine, API | v2 engine; `/api/*` router (119 paths in the CLI's `/openapi.json`; no `/doc` in the SDK router) served through an owned `fetch`; typed client `@opencode-ai/client` | v1 engine; documented v1 routes (`opencode.ai/docs/server`, `/doc`) plus an "Experimental HttpApi surface" `/api/*` whose bodies differ from the SDK (`{prompt:{text}}` vs `{text}`); unknown `/api` paths return the web UI with 200 | ACP over stdio (initialize, session/new|load|list|resume|close, unstable fork/set_model, set_mode, set_config_option, prompt, cancel) + `_meta.terminal-auth`; documented at `opencode.ai/docs/acp` | v2 engine; `/api/*` only (140 operations), OpenAPI at `/openapi.json` titled "Experimental HttpApi… 0.0.1"; CLI help only, no docs page |
| Features Claxedo uses today | All present in-process: catalog/definition/binding/disabled-providers plugins, session tools via `tool.transform` + callback URL, skills/MCP per location, `model.list` (empty on first call), permissions + forms, commands, agents, `switchModel`, fork, revert, steer/queue inbox, `message.list` paging, `context`, tokens/cost, rename; `X-Session-Id`/`x-opencode-session` stamped | Sessions, messages (`/message?limit&before`), prompt_async, abort, fork, revert, summarize, agents, commands, permissions, questions, MCP add, provider list; custom providers only through config files; **no host tools** (MCP only); steer/queue only via the experimental route | Text/thought chunks, tool_call(+update, kinds execute/fetch/edit/search/read/think/other, rawInput/rawOutput/locations), permissions (once/always/reject), modes, model select, available commands, usage after the turn, MCP servers per session, session/load replay, fork; **no questions** (`question.asked` unhandled), **no steer/queue**, **no rename/title API**, **no child sessions** (task tool → "think"), no message paging, no host tools except MCP | As (1) over HTTP (forms, inbox steer/queue, instructions entries, rename, move, permission reply, fork, compact, export, skill, shell), credential store API (`integration/{id}/connect/key`, `credential/{id}/activate`), plugin management (`/api/plugin`); **no transform API**: custom rows and bindings come from config files at boot or the credential store |
| Credentials for the owner (ruling 1) | Rows per owner in the catalog plugin, switched by `switchModel` per session; live re-bind 25 ms (14 ms across the process boundary); no stored secret | Rows per owner in `opencode.json` per directory; any change disposes the directory (aborts its turns) or everything (global); `PUT /auth` inert until dispose; keys visible in `GET /provider` | Config files of the process; a change = restart the process (per-session process makes that per session) | Rows in config at boot (`config.content` or `opencode.json`); key switch live via `connect/key` (204, `credential.switched`, in-flight turn untouched, next turn on the new key) but stored in SQLite `credential.value`; plugins only as npm packages |
| Events + Claxedo translator | v2 events (`session.execution.*`, `session.step.*`, `session.text.delta`, `session.inbox.*`, `session.usage.*`, `catalog/credential.*`) over `/api/event` SSE; translator = `workspace-runtime/src/opencode/harness-adapter.ts` `projectTurnEvent` + `turn-usage.ts` | v1 SSE (`message.part.updated/delta`, `session.status`, `session.idle`, `session.next.*` on `/api/event`); translator = `opencode-server-adapter/src/translate.ts` (capabilities: no permissions/questions/commands/fork) | `session/update` kinds; translator = `agent-event-runtime/src/harnesses/acp` + `agent-sdk-runtime/src/harnesses/acp` (all 10 kinds) | Same v2 events as (1) (15 types seen in one turn); the (1) translator applies |
| Protocol to Claxedo | FACT: the SDK router served over loopback TCP as-is (Bun.serve, or a Node http→Request adapter) plus a Claxedo control route in the same child; unix sockets possible; `EmbeddedHost.create` is `dist/internal/host.js` (not in `exports`; deep import) | HTTP as documented | stdio JSON-RPC; the process also opens an **unauthenticated** TCP server on 127.0.0.1:4096+ | HTTP + mandatory Basic auth; `--stdio` = bind a random TCP port, print `{url}`, exit when stdin closes (not a stdio transport) |
| Runtime, packaging | Node 24 + the five patches (unpatched 19271 fails on Node: `ERR_MODULE_NOT_FOUND …/internal/host`); Bun runs it unpatched; closure 326 MiB (repo README, 18684) / 490 MB npm install (533 pkgs); Electron 44.4.3 = Node 24.21.0 verified in the README; Windows: `@opencode-ai/pty` has no win32 package (unverified gate) | CLI binary 144 MB (windows/linux/darwin published); installs `@opencode-ai/plugin` + 30 packages into `~/.config/opencode/node_modules` with npm at startup (network); `opencode upgrade` manual, config `autoupdate` key (`true|false|"notify"`) | Same binary as (2) | Compiled binary 183 MB (`@opencode-ai/cli-{darwin,linux,windows}-*` published); no Node, no patches |
| Memory, startup (measured) | bun child: 684 ms cold (child ready 55 ms after load), 572 MB idle, 574 MB after a session, 792 MB after a turn; restart 435-470 ms | 511 ms; 381-417 MB idle; +5-27 MB per directory; 700-960 MB after activity | initialize 511 ms; 394 MB; 561 MB after session/new; 692 MB after a turn; restart 510 ms | `opencode2 serve`: 275 ms cold, 184 MB idle, 686 MB after the first session, 690 MB after a turn; restart 156 ms; `--service` 383 MB; `ServerProcess.start` under bun: 830 ms, 582 MB idle, 826 MB after a session |
| Crash scope | worker = every session of the runtime | server = every session of the runtime | per process (per session if one process per session) | server = every session of the runtime |
| Security | Claxedo-owned socket; the SDK authorizes nothing per workspace (`scope.ts`), so the parent gates | Unsecured unless `OPENCODE_SERVER_PASSWORD`: any local process can prompt with the user's keys, spawn shells (`POST /pty {command,args,cwd,env}`, `/session/{id}/shell`), read files (`/file/content`, `/api/fs/read/*`), add local MCP servers (`POST /mcp`), write `auth.json` (`PUT /auth`), read `options.apiKey` (`GET /provider`), dispose everything | stdio is private, but the embedded server on 4096+ is the same unsecured surface as (2) | 401 without the password; password in `service.json` in plaintext and printed by `pair`; `--stdio` still binds TCP |
| Project-folder config | `config.project` option exists in `ServerOptions` (default behaviour not verified) | Reads `opencode.json(c)` up to the worktree root, `.opencode/`, `AGENTS.md`, `plugin` entries (npm install + code); `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips | as (2) | as (2) for config; global `~/.config/opencode/opencode.json` rows observed |
| Writes | Claxedo-chosen DB path; `~/.local/share/opencode/{repos,shell,log}`, `~/.local/state/opencode`, `~/.cache/opencode/bin`; nothing in the project | `~/.local/share/opencode/{opencode.db, auth.json, log, snapshot/<project> (git snapshots), repos}`, `~/.config/opencode/{opencode.jsonc, package.json, package-lock.json, node_modules}`, `~/.npm`; `<project>/config.json` on PATCH; dev also `<project>/.git/opencode` | as (2) | `~/.local/share/opencode/opencode.db` (same file name as v1), `repos`, `shell/<hash>`, `log`; `service.json`; nothing in the project |
| Recovery | SQLite v2 tables (`session_v2`, `session_message`, `session_inbox`, `event`, `instruction_*`, `credential`, `kv`); after kill -9: session `outcome: "failed"`, synthetic "The server restarted", no auto-resume; `prompt {resume:true}` admitted but no model request within 3 s (UNKNOWN) | SQLite v1 tables (`session`, `message` JSON `data`, `part`, `todo`, `permission`, `event`); after kill -9: sessions listed, status `{}`, the interrupted assistant message stays incomplete (no error) and is replayed as an empty assistant turn; new prompt completes | Same DB as (2); `session/load` replays user/assistant chunks (nothing for the interrupted message); next prompt completed in 898 ms | With a `lifecycle` (`ServerProcess.start`): the orphaned turn was **replayed** after restart (`active: running`); `opencode2 serve`: no replay within 4 s, no error marker (launcher-dependent) |
| Stability | 41 beta SDK versions in 30 days; 18684→19271 renamed `CatalogDraft/IntegrationDraft` → `*Editor`, narrowed `Context.plugin`, added `rpc`/`worktree`/`instances`, dropped `Plugin.tui/vcs`; Claxedo's `src/opencode` typechecks with 0 errors; `internal/host` is unexported | v1 stable weekly; `/api` experimental; upstream's future is v2 | ACP core stable; opencode marks fork/set_model `unstable_`; questions unsupported | Same beta churn as (1); "experimental" in its own OpenAPI; `beta`/`next`/`latest` tags disagree (17823 vs 19271) |

## Hard limits (cannot be fixed on Claxedo's side)

- (3) ACP: no questions/forms, no steer or queue, no session rename, no child-session surfacing, no message paging,
  no host tools other than MCP, one directory per process, credentials only by process restart, and (v1) an
  unauthenticated TCP server as a side effect.
- (2) v1 serve: credential/config changes abort running turns (per directory) or everything (global); `PUT /auth`
  inert until dispose; no host tools other than MCP; plaintext keys in `GET /provider`; unsecured by default; v1 is
  the engine upstream is leaving.
- (4) v2 server: no transform/plugin API over HTTP, so owner rows must be config at boot or DB-stored credentials;
  password in `service.json`; `--stdio` still binds TCP; restart replay depends on the launcher; experimental API.
- (1) worker: Node needs the patched closure (or a Bun sidecar, which `host.ts` forbids); the SDK authorizes nothing
  per workspace; `EmbeddedHost` deep import; ~570 MB idle per worker; beta churn; Windows PTY package missing.

Fixable at a cost: MCP server for Claxedo tools in (2)(3)(4) (the `first-party-mcp` module exists); per-owner rows
via config for (2)(4) with abort (2) or credential-store swaps (4); a Claxedo IPC/auth layer for (1) (control route +
socket permissions, ~a day of code, proven in `worker-child.mjs`); a v1 SSE/ACP translator is already in the repo.
