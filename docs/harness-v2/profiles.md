# Harness profiles (plan P0.6)

Research artifact for the harness-rebuild plan. A **profile** records how
skills, MCP servers and plugins get into a harness, taken from that harness's
own documentation — not from how Claxedo connects to it. Every rule cites its
source: an absolute path (local installed docs/types/binaries), a URL
(official docs), or a repository path (current Claxedo behavior, evidence
only — not documentation).

Facts that could not be confirmed are marked `UNVERIFIED` with what was tried.

## Claude Code (CLI + Agent SDK)

| Item | Finding | Source |
|---|---|---|
| Skills — user | `~/.claude/skills/<skill>/SKILL.md` ("personal skills"); also plugin-supplied skills | https://code.claude.com/docs/en/skills.md |
| Skills — project | `.claude/skills/<skill>/SKILL.md`; nested directories discovered; additional directories reachable via `--add-dir`; skill dirs watched for changes | https://code.claude.com/docs/en/skills.md |
| Skills — flag/SDK | SDK `Options.skills?: string[] \| 'all'` — explicit skill paths; `Options.settingSources` (`'user' \| 'project' \| 'local'`) selects which filesystem setting tiers load (default: all; `[]` disables all filesystem settings; `'project'` required for `CLAUDE.md`) | /Users/yashvardhansingh/test/opencode-harness/packages/agent-sdk-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts (~lines 1901–1959) |
| MCP — config file/format | Project `.mcp.json`; user/local scopes in `~/.claude.json`; managed settings; plugin `.mcp.json` or `mcpServers` in plugin manifest. JSON `mcpServers` map | https://code.claude.com/docs/en/mcp.md, https://code.claude.com/docs/en/plugins.md |
| MCP — transports | stdio, SSE, streamable HTTP (docs also list WebSocket); CLI `claude mcp add` / `add-json` with `--transport`, scopes, headers, env | https://code.claude.com/docs/en/mcp.md |
| MCP — per-session | SDK `Options.mcpServers?: Record<string, McpServerConfig>` accepts stdio/sse/http/sdk (in-process) configs; `Options.strictMcpConfig` restricts session to explicitly passed servers | sdk.d.ts (~lines 1035–1179, ~1901–1959) |
| Plugins | Directory with optional `.claude-plugin/plugin.json`; components `skills/`, `agents/`, `commands/`, `hooks/`, `.mcp.json`. Enablement: marketplaces + `enabledPlugins` in settings, or `claude --plugin-dir <path>`; SDK `Options.plugins?: SdkPluginConfig[]` = `{type:'local', path, skipMcpDiscovery?}` | https://code.claude.com/docs/en/plugins.md; sdk.d.ts (~lines 1758–1771, ~4196–4208) |
| Config-home override | `CLAUDE_CONFIG_DIR` env var redirects settings, session history, and plugin storage away from `~/.claude`/`~/.claude.json`; sessions persist under `<config-dir>/projects/` unless SDK `persistSession:false` | https://code.claude.com/docs/en/env-vars.md; sdk.d.ts (~lines 1580–1595) |
| Override hides | Auth/session state (`~/.claude/.credentials.json` keychain-or-file), session history, installed plugins, user settings, skills | https://code.claude.com/docs/en/env-vars.md, https://code.claude.com/docs/en/settings.md |
| Credentials | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, OAuth token file in config dir; base URL override via `ANTHROPIC_BASE_URL` (proxy/gateway); Bedrock/Vertex env toggles | https://code.claude.com/docs/en/env-vars.md |
| Adds or replaces | **Add**: settings merge across user/project/local precedence; `--add-dir`, `--plugin-dir`, SDK `skills`/`plugins`/`mcpServers` are additive. **Replace possible**: `settingSources: []` + generated `CLAUDE_CONFIG_DIR` + `strictMcpConfig` give an exact set | https://code.claude.com/docs/en/settings.md; sdk.d.ts |

## claude-agent-acp (ACP wrapper over the Agent SDK)

| Item | Finding | Source |
|---|---|---|
| Passthrough | `NewSessionRequest._meta.claudeCode.options` is spread into SDK `Options`. Managed keys are NOT forwarded: `cwd`, `includePartialMessages`, `permissionMode`, `canUseTool`, `executable`, `agent`. Merged keys: `hooks`, `mcpServers`, `disallowedTools`; `tools` defaults to `claude_code` preset | https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/main/src/acp-agent.ts (`NewSessionMeta` doc comment, ~line 1355; `OPTION_REBUILDS_SESSION`, ~lines 1211–1290) |
| Skills | `options.skills` passes through to the SDK (normalized as a set for session fingerprinting); `_meta.additionalRoots` accepted on session/new | acp-agent.ts `normalizeSkills`/`computeSessionFingerprint` (~lines 1204–1345) |
| MCP | ACP `mcpServers` on session/new are merged with `options.mcpServers`; all SDK MCP transports (stdio/sse/http/sdk) pass through | acp-agent.ts `NewSessionMeta` comment; sdk.d.ts MCP types |
| Plugins | `options.plugins` (`SdkPluginConfig[]`) passes through — Claxedo can deliver plugin dirs per-session via `_meta` | acp-agent.ts `OPTION_REBUILDS_SESSION.plugins: true` (~line 1248) |
| Config home | Inherits SDK/CLI: `CLAUDE_CONFIG_DIR` in env, or `options.env`/`options.settingSources` via `_meta` | sdk.d.ts; acp-agent.ts |
| Native folders | Wrapper spawns the real Agent SDK/Claude Code process, so `~/.claude`, `.claude/`, `.mcp.json` are read per `settingSources` (current Claxedo adapter sets `settingSources: ["user","project","local"]` and does NOT set `plugins`) | /Users/yashvardhansingh/test/opencode-harness/packages/claxedo-local-server/src/agent-plugins/runtime/adapters/claude.ts |
| Auth | `_meta.claudeCode.vertex` / gateway auth meta maps to env vars for baseUrl + headers injection | acp-agent.ts `GatewayAuthMeta` (~line 1407) |

## Codex (CLI + `codex app-server`)

| Item | Finding | Source |
|---|---|---|
| Skills — locations | Directory containing `SKILL.md` (+ optional `agents/openai.yaml`, scripts/references/assets). User: `$CODEX_HOME/skills/`; repo/project: `.agents/skills/`; admin/system + bundled roots; symlinked skill folders supported; `[[skills.config]]` in `config.toml` disables individual skills | https://developers.openai.com/codex/skills.md |
| Skills — flag | `--add-dir` extends workspace roots (extra roots contribute `.agents/skills` via app-server `skills/extraRoots/set`); no standalone `--skill` flag observed | `codex --help` (codex-cli 0.156.1); codex-acp `CodexAcpClient.refreshSkills` |
| MCP — config | `mcp_servers` TOML table in `$CODEX_HOME/config.toml`; `codex mcp add <name> <cmd>` (stdio) or `--url` (streamable HTTP), `--env`, `--bearer-token-env-var`; `-c key=value` config overrides | `codex mcp --help`; https://developers.openai.com/codex/config-advanced.md |
| MCP — transports | stdio and streamable HTTP documented; **SSE: UNVERIFIED** — codex-acp explicitly rejects `sse` ("Codex doesn't support MCP SSE transport protocol"), and no SSE transport found in config docs | https://raw.githubusercontent.com/agentclientprotocol/codex-acp/main/src/CodexAcpClient.ts `createMcpSeverConfig` (~line 905); https://developers.openai.com/codex/config-advanced.md |
| MCP — per-session | `codex app-server` accepts `mcp_servers` in session config (JSON-RPC); codex-acp maps ACP `mcpServers` into it with dedup against existing config layers via `configRead` | codex-acp `CodexAcpClient.ts` (~lines 840–885); `codex app-server --help` |
| Plugins | `codex plugin add\|list\|remove\|marketplace`; plugins bundle skills + MCP servers + connectors; installed/configured via marketplace config in `config.toml` and a plugin cache under `$CODEX_HOME` | https://developers.openai.com/codex/plugins.md; `codex plugin --help` |
| Config-home override | `CODEX_HOME` env var (default `~/.codex`). Holds `config.toml`, `auth.json`/keychain creds, `history.jsonl`, `log/`, `sessions/`, plugin cache, `<profile>.config.toml` profiles | https://developers.openai.com/codex/config-basic.md, https://developers.openai.com/codex/auth.md |
| Override hides | Login (`auth.json`), session rollouts/history, cached plugins, user skills dir, profiles | https://developers.openai.com/codex/auth.md, skills.md, plugins.md |
| Credentials | `OPENAI_API_KEY` env or `codex login` → `~/.codex/auth.json`; `CODEX_ACCESS_TOKEN`; custom `model_providers.<id>` with `base_url`, `env_key`, command-backed creds | https://developers.openai.com/codex/auth.md, config-advanced.md |
| App-server transport | `codex app-server` serves JSON-RPC over `stdio://` (default), `unix://`, `ws://`, `off`; `--remote`/`--remote-auth-token-env` for remote | `codex app-server --help` (0.156.1) |
| Adds or replaces | **Add**: `-c mcp_servers…` and `config.toml` layers merge; project `.codex/config.toml` adds for trusted projects; `skills/extraRoots/set` adds roots. **Replace possible**: generated `CODEX_HOME` with only `config.toml` hides auth/plugins/skills (current Claxedo broker does this — evidence, not docs) | https://developers.openai.com/codex/config-basic.md; /Users/yashvardhansingh/test/opencode-harness/packages/claxedo-local-server/src/agent-plugins/runtime/adapters/codex.ts |

## codex-acp (ACP wrapper over `codex app-server`)

| Item | Finding | Source |
|---|---|---|
| Process model | Spawns `codex app-server` (`CODEX_PATH` override or bundled codex) over stdio JSON-RPC; inherits process env | https://raw.githubusercontent.com/agentclientprotocol/codex-acp/main/src/CodexJsonRpcConnection.ts (~lines 16–25) |
| Env inputs | `CODEX_PATH` (binary), `CODEX_CONFIG` (JSON parsed and merged as base config), `DEFAULT_AUTH_REQUEST`, `MODEL_PROVIDER` | https://raw.githubusercontent.com/agentclientprotocol/codex-acp/main/src/index.ts (~lines 79–100) |
| MCP passthrough | ACP `mcpServers` → Codex `mcp_servers` in session config; `http` → `{url, http_headers}`; stdio → `{command, args, env}`; `acp` and `sse` transports REJECTED; dedup against existing config layers via `configRead {includeLayers}` | CodexAcpClient.ts `createMcpSeverConfig` (~line 905), `getConfigMcpServerNames` (~line 858) |
| Skills passthrough | Each ACP additional root contributes `<root>/.agents/skills` via `skills/extraRoots/set`; `skills/list` force-reloaded over `[cwd, ...additionalRoots]` | CodexAcpClient.ts `refreshSkills` (~lines 879–896) |
| Project trust | Session roots injected into config `projects` with `trust_level: "trusted"` (makes project `.codex` layers apply) | CodexAcpClient.ts (~lines 828–833) |
| Plugins | No plugin passthrough observed — plugin delivery would have to come through `CODEX_CONFIG`/`config.toml` marketplace config | codex-acp src (index.ts, CodexAcpClient.ts) — searched for plugin forwarding, none found |
| Native folders | Real codex process → reads `$CODEX_HOME` (`CODEX_HOME` env respected), `.codex/config.toml`, `$CODEX_HOME/skills/` natively | CodexJsonRpcConnection.ts (env passthrough); Codex config docs |
| Adds or replaces | Session `mcpServers` merge with existing config (dedup keeps user's same-named servers); skill extra roots are additive | CodexAcpClient.ts (~lines 843–885) |

## Cursor (`cursor-agent` + `@cursor/sdk`)

| Item | Finding | Source |
|---|---|---|
| Skills | Agent Skills standard; auto-discovered from `.cursor/skills/` + `.agents/skills/` (project, incl. nested dirs — nested skills scope to their subtree), `~/.cursor/skills/` + `~/.agents/skills/` (user), plus compat dirs `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, `~/.codex/skills/`; recursive `SKILL.md` walk; frontmatter `name`+`description` required, optional `paths`, `disable-model-invocation` | https://cursor.com/docs/skills |
| MCP — config file/format | `.cursor/mcp.json` (project) and `~/.cursor/mcp.json` (global); `{"mcpServers": {...}}` map; stdio: `command`/`args`/`env`/`envFile`/`type:"stdio"`; remote: `url`+`headers`+optional static OAuth `auth`; `${env:…}`, `${workspaceFolder}` interpolation | https://cursor.com/docs/context/mcp |
| MCP — transports | stdio, SSE, streamable HTTP (docs table) | https://cursor.com/docs/context/mcp |
| MCP — per-session | SDK `AgentOptions.mcpServers?: Record<string, McpServerConfig>` (stdio `{command,args,env,cwd}` or `{url,headers}`); `cursor-agent --approve-mcps`; IDE extension API `vscode.cursor.mcp.registerServer()` | /Users/yashvardhansingh/test/opencode-harness/node_modules/.bun/@cursor+sdk@1.0.24/node_modules/@cursor/sdk/dist/esm/options.d.ts; `cursor-agent --help`; https://cursor.com/docs/context/mcp |
| Plugins | Cursor Plugin: root `plugin.json` or `.cursor-plugin/plugin.json`; components `skills/`, `rules/`, `agents/`, `commands/`, `hooks/hooks.json`, `mcp.json`; local dev path `~/.cursor/plugins/local/<plugin>`; `cursor-agent --plugin-dir <path>` (repeatable) | https://cursor.com/docs/plugins; `cursor-agent --help` |
| Plugin scoping caveat | Plugin install/discovery is machine-scoped (`~/.cursor/plugins`, `CURSOR_PLUGIN_ROOT` env in binary) — no per-session plugin selection; the plan flags Cursor as "last projection wins" across workspaces | https://cursor.com/docs/plugins; binary env vars in /Users/yashvardhansingh/.local/share/cursor-agent/versions/2026.09.15-d2fe57e/*.index.js |
| Config-home override | `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` exist in installed binary (undocumented); what they redirect exactly (auth tokens, session store `CURSOR_AGENT_STORE_DIR`, plugins) — **partially UNVERIFIED**: names confirmed in binary, semantics not documented | binary grep, same version dir; https://cursor.com/docs/cli/reference/parameters (not listed) |
| Credentials | `CURSOR_API_KEY` env / `--api-key` flag; `--endpoint <url>` / `CURSOR_API_ENDPOINT` for backend override; SDK `AgentOptions.apiKey`; `CURSOR_API_BASE_URL`, `CURSOR_BEDROCK_BASE_URL` in binary | `cursor-agent --help`; options.d.ts; binary grep |
| Adds or replaces | Skills/MCP: **add** (project + global files merge; SDK `mcpServers` additive). Plugins: `--plugin-dir` adds per-session, but installed-plugin set is machine-scoped → "exactly these plugins" = **no** without replacing the machine folder | https://cursor.com/docs/plugins, context/mcp, skills |

## OpenCode (CLI, `opencode acp`, server HTTP API)

Version note: installed CLI is `opencode 1.18.32`. Current web docs (updated 2026-09-24) describe `skills/` discovery; the plan notes 1.18.32 has no `skills` config key. Folder discovery is documented independently of any config key.

| Item | Finding | Source |
|---|---|---|
| Skills — locations | `.opencode/skills/<name>/SKILL.md`, `~/.config/opencode/skills/<name>/SKILL.md`, plus Claude/agent-compatible `.claude/skills/`, `~/.claude/skills/`, `.agents/skills/`, `~/.agents/skills/`; walks up from cwd to git worktree root; `permission.skill` allow/deny/ask patterns; native `skill` tool | https://opencode.ai/docs/skills/ |
| MCP — config | `mcp` object in `opencode.json`/jsonc (project) and global config; `type:"local"` → `command[]`, `environment`, `cwd`, `timeout`; `type:"remote"` → `url`, `headers`, OAuth; `enabled` toggle; org `.well-known/opencode` defaults overridable locally | https://opencode.ai/docs/mcp-servers/ |
| MCP — transports | local (stdio) + remote (HTTP); remote supports OAuth. **SSE: UNVERIFIED** — docs say "remote" without enumerating SSE vs streamable HTTP | https://opencode.ai/docs/mcp-servers/ |
| MCP — per-session | Server HTTP API `PATCH /config` accepts `mcp`/`plugin`/`instructions` (per the plan + `@opencode-ai/sdk` config types); CLI `opencode mcp` manages config file entries | plan `2026-09-24-002`; https://opencode.ai/docs/config/ |
| Plugins | JS/TS files in `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global); npm packages via `plugin` array in config (cached `~/.cache/opencode/node_modules`); plugins add tools/hooks/env | https://opencode.ai/docs/plugins/, /docs/config/ |
| Config-home override | `OPENCODE_CONFIG` → custom config file path; `OPENCODE_CONFIG_DIR` → custom config dir (searched for agents, commands, modes, plugins — and per config page, `skills/`, `tools/`, `themes/` subdirs); `OPENCODE_CONFIG_CONTENT` inline JSON. Configs are MERGED, not replaced | https://opencode.ai/docs/config/ |
| Override hides | Auth is NOT in config dir: credentials live in `~/.local/share/opencode/auth.json` (from `/connect`); sessions under `~/.local/share/opencode/`. So `OPENCODE_CONFIG_DIR` override does NOT hide login state — different from CLAUDE_CONFIG_DIR/CODEX_HOME | https://opencode.ai/docs/providers/ |
| Credentials | `opencode auth login` / `/connect` → `~/.local/share/opencode/auth.json`; per-provider env vars (e.g. `AWS_*`, and AI-SDK provider env vars); per-provider `provider.<id>.options.baseURL` in config | https://opencode.ai/docs/providers/ |
| ACP | `opencode acp` serves ACP from the same binary/config; whatever config is in effect applies | `opencode --help` (1.18.32); https://opencode.ai/docs/acp/ |
| Adds or replaces | **Add**: config layers merge (custom file/dir is another layer); project `.opencode/plugins`, `skills/` dirs, `mcp` entries all additive alongside user config | https://opencode.ai/docs/config/ |

## Pi (`@earendil-works/pi-coding-agent`)

All paths below are under the pinned package:
`/Users/yashvardhansingh/test/opencode-harness/packages/agent-sdk-runtime/.artifacts/pi/node_modules/@earendil-works/pi-coding-agent` (abbreviated `PI_PKG`).

| Item | Finding | Source |
|---|---|---|
| Skills — locations | Global: `~/.pi/agent/skills/`, `~/.agents/skills/`; project: `.pi/skills/`, `.agents/skills/` (cwd + ancestors to repo root); packages: `skills/` dirs and `pi.skills` in `package.json`; settings `skills` array (files/dirs); repeatable `--skill <path>` flag — additive even with `--no-skills` | PI_PKG/docs/skills.md |
| Skills — compat | Loads Claude/Codex skills by adding their dirs to settings; recursive `SKILL.md` dir discovery | PI_PKG/docs/skills.md |
| MCP | **None** — "No MCP" in README/docs; Pi's tool model is TS extensions | PI_PKG/README.md, docs/extensions.md |
| Plugins (= extensions) | TypeScript extensions: global `~/.pi/agent/extensions/`, project `.pi/extensions/`, explicit `-e <path>`; register tools/commands/event handlers/state; Pi packages can bundle extensions + skills + prompt templates + themes | PI_PKG/docs/extensions.md, docs/packages.md |
| Config-home override | `PI_CODING_AGENT_DIR` (default `~/.pi/agent`): settings.json, auth.json, packages, extensions, models, sessions; `PI_CODING_AGENT_SESSION_DIR` (superseded by `--session-dir`); `PI_PACKAGE_DIR`; `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK` | PI_PKG/docs/environment-variables.md |
| Override hides | `auth.json` (login), session store, installed packages/extensions, user skills, custom models — a generated `PI_CODING_AGENT_DIR` starts unauthenticated unless creds copied or env keys set | PI_PKG/docs/environment-variables.md, docs/settings.md |
| Credentials | Provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, …) or `auth.json`; custom providers + `baseUrl` overrides via `models.json`/custom-provider config | PI_PKG/docs/providers.md, docs/custom-provider.md |
| Adds or replaces | **Add**: every delivery path (`--skill`, `skills` setting, extensions dirs, `-e`) adds to discovered user setup; no replace-only mechanism short of `PI_CODING_AGENT_DIR` isolation | PI_PKG/docs/skills.md, docs/extensions.md |

## Gemini CLI

| Item | Finding | Source |
|---|---|---|
| Skills — locations | `.gemini/skills/<name>/SKILL.md` (project, requires trusted folder via `/trust`), `~/.gemini/skills/` (user scope), `.agents/skills/` alias; `SKILL.md` frontmatter `name`+`description`; `/skills list`, `/skills reload`; `gemini skills install <url-or-path>`, `link <path>`, `uninstall`; `skills.enabled` setting | https://geminicli.com/docs/cli/tutorials/skills-getting-started/; https://geminicli.com/docs/cli/settings/ |
| MCP — config | `mcpServers` in `settings.json` — user `~/.gemini/settings.json`, workspace `<project>/.gemini/settings.json` (workspace overrides user); `command`/`args`/`env`/`cwd`/`envFile` (stdio), `url` (SSE), `httpUrl` (streamable HTTP), `headers`, `trust`, `timeout`, OAuth for remote; `mcp` object for global allowed/excluded; `gemini mcp add/remove/list/enable/disable`; `--allowed-mcp-server-names` flag | https://geminicli.com/docs/tools/mcp-server/; `gemini --help` |
| MCP — transports | stdio, SSE, streamable HTTP | https://geminicli.com/docs/tools/mcp-server/ ("Transport mechanisms") |
| Plugins (= extensions) | `~/.gemini/extensions/<name>/` with root `gemini-extension.json`; components: `mcpServers`, `contextFileName` (GEMINI.md), `commands/`, `hooks/hooks.json`, `skills/`, sub-agents, themes, policies; `gemini extensions install <gh-url\|path> [--ref]`, `link <path>` (local dev symlink), `enable`/`disable [--scope user\|workspace]` | https://geminicli.com/docs/extensions/reference/ |
| Config-home override | `GEMINI_CLI_HOME` — points at dir used instead of `~/.gemini`; holds `settings.json`, `oauth_creds.json`, `google_accounts.json`, `extensions/`, `skills/`, `.env`, `tmp/`/history | https://geminicli.com/docs/reference/configuration/ (env vars table); bundle string in /Users/yashvardhansingh/.local/lib/node_modules/@google/gemini-cli/bundle/ |
| Override hides | OAuth creds + signed-in account (`oauth_creds.json`, `google_accounts.json`), user settings, installed extensions/skills — generated home starts logged-out unless `GEMINI_API_KEY`/`GOOGLE_API_KEY` env is set | https://geminicli.com/docs/get-started/authentication/ |
| Credentials | `GEMINI_API_KEY` (AI Studio), `GOOGLE_API_KEY` (Vertex express), OAuth login files in `~/.gemini/`, `GOOGLE_CLOUD_PROJECT`/`_ID`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_DEFAULT_AUTH_TYPE`; `.env` loaded from project then `~/.gemini/.env`; base URL: `GOOGLE_GEMINI_BASE_URL` | https://geminicli.com/docs/get-started/authentication/, /docs/reference/configuration/; bundle strings |
| ACP | `gemini --acp` runs ACP mode in-process (IDE integration surface) | `gemini --help`; https://geminicli.com/docs/ (IDE integration → ACP mode) |
| Adds or replaces | **Add**: settings layers merge (system → user → project → env → CLI); workspace `.gemini/` adds skills/MCP/settings; `gemini skills/extensions install|link` write into home. Replace possible via `GEMINI_CLI_HOME` to a generated dir | https://geminicli.com/docs/reference/configuration/ (layer precedence) |

## Summary matrix

Cell legend:
- `yes` — feature exists; both additive delivery and exact-set projection are documented/possible
- `add-only` — delivery only adds to the user's discovered setup; no documented way to project an exact set without hiding user dirs
- `replace-only` — delivery only replaces user setup
- `no` — feature not supported/documented
- `UNVERIFIED` — could not confirm (see harness table for what was tried)

| Harness | 1. Skills | 2. MCP | 3. Plugins | 4. Config-home override | 5. Creds + base URL | 6. Add w/o replacing |
|---|---|---|---|---|---|---|
| Claude Code / Agent SDK | yes | yes | yes | yes | yes | yes |
| claude-agent-acp | yes | yes | yes | yes | yes | yes |
| Codex / app-server | yes | yes | yes | yes | yes | yes |
| codex-acp | add-only | add-only | UNVERIFIED | yes | yes | yes |
| Cursor (agent + SDK) | add-only | add-only | add-only | UNVERIFIED | yes | yes |
| OpenCode | add-only | add-only | add-only | yes | yes | yes |
| Pi | add-only | no | add-only | yes | yes | yes |
| Gemini CLI | add-only | add-only | add-only | yes | yes | yes |

Notes:
- `yes` in columns 1–3 means a per-session mechanism (SDK option, flag, protocol field, or merged config layer) can carry an exact projected set; `add-only` means projected items merge with whatever the user already has, and "exactly these" requires config-home isolation instead.
- Cursor plugin caveat: `--plugin-dir` adds per-session, but installed plugins are machine-scoped — "exactly these plugins" across workspaces is not documented.
- codex-acp plugins: no dedicated ACP passthrough found; `CODEX_CONFIG` JSON could carry `config.toml` keys, but plugin fetch/install from it is unverified.
- Cursor `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR`/`CURSOR_PLUGIN_ROOT` strings exist in the installed `cursor-agent` 2026.09.15 bundle but are not in the published parameter reference.
- Config-home override consequence differs: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `GEMINI_CLI_HOME` all hide auth/session state; `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR` do NOT hide auth (`~/.local/share/opencode/auth.json` is outside the config dir).
- Remote delivery (plan): only MCP `remote`/HTTP-style servers can cross to a remote harness; stdio/skills/plugin folders are local-only per the plan's "Remote harnesses" section.

## Sources

Local (installed/pinned):
- `/Users/yashvardhansingh/test/opencode-harness/packages/agent-sdk-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `README.md`
- `/Users/yashvardhansingh/test/opencode-harness/node_modules/.bun/@cursor+sdk@1.0.24/node_modules/@cursor/sdk/dist/esm/options.d.ts`
- `/Users/yashvardhansingh/test/opencode-harness/packages/agent-sdk-runtime/.artifacts/pi/node_modules/@earendil-works/pi-coding-agent/` (`docs/`, `README.md`)
- `codex` 0.156.1 `--help`, `codex app-server --help`, `codex mcp --help`, `codex plugin --help` (`/Users/yashvardhansingh/.local/bin/codex`)
- `cursor-agent` 2026.09.15-d2fe57e `--help` + binary env-var strings (`/Users/yashvardhansingh/.local/share/cursor-agent/versions/2026.09.15-d2fe57e/`)
- `opencode` 1.18.32 `--help`; `gemini` `--help` + bundle strings (`/Users/yashvardhansingh/.local/lib/node_modules/@google/gemini-cli/bundle/`)

Web (official docs/source):
- https://code.claude.com/docs/en/{skills,mcp,plugins,settings,env-vars}.md
- https://developers.openai.com/codex/{skills,config-basic,config-advanced,plugins,auth,config-reference}.md
- https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/main/src/acp-agent.ts
- https://raw.githubusercontent.com/agentclientprotocol/codex-acp/main/src/{index,CodexAcpClient,CodexAppServerClient,CodexJsonRpcConnection,CodexCli}.ts
- https://cursor.com/docs/{skills,plugins,context/mcp,cli/reference/parameters}
- https://opencode.ai/docs/{config,plugins,mcp-servers,skills,providers,acp}/
- https://geminicli.com/docs/{cli/tutorials/skills-getting-started,cli/settings,tools/mcp-server,extensions/reference,reference/configuration,get-started/authentication}/

Repository (current behavior, evidence only):
- `packages/claxedo-local-server/src/agent-plugins/runtime/adapters/{claude,codex,cursor,opencode,native,mcp-projection}.ts`
- `packages/agent-sdk-runtime/src/harnesses/acp/`

## UNVERIFIED items (all)

1. Codex MCP SSE transport — docs list stdio + streamable HTTP; codex-acp rejects SSE outright.
2. OpenCode remote MCP SSE vs streamable HTTP — docs say only `type:"remote"`.
3. Cursor `CURSOR_CONFIG_DIR` semantics — env string in binary, undocumented; exact redirected state unconfirmed.
4. codex-acp plugin delivery — no passthrough found; `CODEX_CONFIG` plugin/marketplace keys untested.
5. Whether `OPENCODE_CONFIG_DIR` custom dir is searched for `skills/` — config page lists `skills/` among searched subdirs for `.opencode` dirs but the `OPENCODE_CONFIG_DIR` paragraph names only "agents, commands, modes, and plugins".
