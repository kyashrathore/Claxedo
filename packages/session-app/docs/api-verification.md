# Composer data-layer API verification (2026-08-15)

Against the REAL desktop-local server composition (`dev/start-real-local-server.ts`,
`http://127.0.0.1:4480`, data dir `/tmp/claxedo-session-app-hGIC`, workspace
`/root/session-app-real`). Every endpoint below was exercised for real — first
with curl, then through `createComposerClient` /
`createLocalServerClient` (scratchpad `live-composer-smoke.ts`). Samples truncated.

## GET /api/claxedo/agent-config/harness?directory=…

`listHarnesses` reads `activeType` from this to flag the active harness:

```json
{"harness":{"id":"opencode","access":"native"},"activeType":"opencode",
 "activeHarness":{"id":"opencode","access":"native"},"status":"ready","ready":true,
 "workspaceId":"16c8b53e-…","directory":"/root/session-app-real","harnessHealth":{"status":"ok"}}
```

## GET /api/claxedo/agent-config/harness/options?directory=…&harness=claude-acp

Answers the `OptionsResponse` shape when the harness can start; in this
container the claude binary can't, so the tolerated error body came back
(decoder degrades to `{models: [], efforts: [], source: "empty", stale: true, error}`):

```json
{"error":{"code":"harness_config_options_unavailable","message":"ACP newSession timed out after 10000ms"}}
```

## GET /provider?directory=…&harness=opencode[&provider=anthropic]

Index view: 185 providers, `models` maps empty; `connected` + `default` populated.
Detail view fills models (including `variants` — the effort levels):

```json
{"all":[{"id":"anthropic","name":"Anthropic","models":{"claude-opus-4-7":{
  "name":"Claude Opus 4.7","status":"active",
  "variants":{"low":{"effort":"low"},"medium":{…},"high":{…},"xhigh":{…},"max":{…}}}, …}}],
 "connected":["amazon-bedrock","cloudflare-ai-gateway","github-copilot","anthropic","opencode"],
 "default":{"anthropic":"claude-opus-4-8", "opencode":"big-pickle", …}}
```

## GET /permission/modes?directory=…&harness=…

claude-acp (6 modes, harness's own ids/names/levels):

```json
{"modes":[{"id":"auto","name":"Auto","description":"Use a model classifier…","level":"auto"},
  {"id":"default","name":"Manual","description":"Standard behavior…","level":"ask"},
  {"id":"acceptEdits","name":"Accept Edits",…},{"id":"plan","name":"Plan Mode",…},
  {"id":"dontAsk",…},{"id":"bypassPermissions",…}],"appliesFrom":"next-turn"}
```

codex-acp: `read-only` / `agent` / `agent-full-access`.
opencode: `{"modes":[],"unsupported":"opencode has no permission modes of its own","appliesFrom":"next-turn"}`.

## GET /api/claxedo/workspace

```json
{"workspaces":[{"workspaceId":"16c8b53e-…","directory":"/root/session-app-real",
  "workspaceName":null,"access":"local","backing":{"kind":"local-worktree",…},
  "git":{"repo":"session-app-real","branch":null,"remote":null}}, …]}
```

`access` is `"local" | "cloud" | "user-hosted"` (workspaceResponse in
claxedo-server-core/workspace/store/response.ts).

## GET + POST /experimental/worktree?directory=…

- POST body `{"name":"data-layer-probe"}` →
  `{"name":"data-layer-probe","branch":"opencode/data-layer-probe","directory":"/tmp/claxedo-session-app-hGIC/worktree/16c8b53e-…/data-layer-probe"}`
- GET → `["/tmp/claxedo-session-app-hGIC/worktree/16c8b53e-…/data-layer-probe"]`
- On a repo with no commits the create is refused with
  `{"error":{"code":"opencode_worktree_create_failed","message":"…'--orphan' and '--no-checkout' cannot be used together"}}`
  (the probe repo needed one commit first). Smoke-created worktrees were
  DELETEd again via the same route.

## GET /provider/auth

```json
{"claude-acp":[{"type":"api","label":"API Key"}],
 "codex-acp":[{"type":"oauth","label":"ChatGPT Pro/Plus (headless)"},{"type":"api","label":"API Key"}],
 "openai":[{"type":"oauth",…},{"type":"oauth",…},{"type":"api","label":"Manually enter API Key"}],
 "github-copilot":[{"type":"oauth","label":"Login with GitHub Copilot","prompts":[…]}], …}
```

## PUT /api/claxedo/credentials

Body `{"provider_id":"claude-acp","kind":"api_key","secret":"sk-test-probe"}` →

```json
{"credential":{"id":"20d4f6dd-…","provider_id":"claude-acp","kind":"api_key",
 "source":"managed","status":"available","has_secret":true,"scope":"local",…}}
```

`GET /api/claxedo/credentials` listed it back.

## POST /session/:id/message — prompt body fields

`SessionPromptBody` (workspace-runtime/src/session/service.ts) accepts exactly:
`parts`, `messageID`, `agent`, `model: {providerID, modelID}`, `tools`,
`format`, `system`, `variant` (reasoning effort), `permissionMode`. The
extended `sendPrompt` and the `send-prompt` effect use these names verbatim
(pinned by `local-server-client.test.ts` and the composer submit test).
Read-back of `GET /session/:id/config` for an existing session:
`{"harness":{"id":"opencode","access":"native"},"variant":null,"agent":null}`.
