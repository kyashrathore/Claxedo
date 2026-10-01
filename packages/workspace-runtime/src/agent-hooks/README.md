# Terminal-tab agent status

These hooks report running, waiting and done status for agent CLIs that a person starts inside a Claxedo terminal tab. They never serve harness sessions: every script exits unless `CLAXEDO_TAB_ID` is set, and `/api/wr/hook/agent-lifecycle` is keyed by tab and terminal.

## Channels that write nothing into the person's folders

- **Claude Code.** The `claude` wrapper passes `--settings <data>/hooks/claude-settings.json`.
- **Codex.** Inside a tab, the `codex` wrapper runs `codex --enable hooks --dangerously-bypass-hook-trust -c hooks.<Event>=[…]`. The events are SessionStart, SessionEnd, UserPromptSubmit, PreToolUse (only `^request_user_input$`), PostToolUse, PermissionRequest, Stop, Interrupt, SubagentStart and SubagentStop.
  - Codex skips a hook it has not trusted, so the bypass flag is required.
  - **Trade-off (owner-approved 2026-09-28):** for that terminal run, the bypass also lets the person's own `~/.codex/hooks.json` and a repository's `.codex/hooks.json` run without Codex's trust review.
  - Outside a tab, the wrapper passes the person's arguments through unchanged, and harness sessions never pass the flag.

## Writers into the person's config (owner-approved, like superset.sh)

| CLI | What Claxedo writes, and where |
|---|---|
| Cursor | `~/.cursor/hooks.json`, entries under `hooks` running `<data>/hooks/cursor-hook.sh <Event>` |
| Gemini | `~/.gemini/settings.json`, `hooks.BeforeAgent` / `AfterAgent` / `AfterTool` running `<data>/hooks/gemini-hook.sh` |
| Antigravity | `~/.gemini/config/hooks.json`, its own `claxedo-lifecycle` key |
| Droid | the file in effect: `~/.factory/hooks.json` when it exists, otherwise `hooks` in `~/.factory/settings.json`; `hooks.json` is never created |
| Mastra | `~/.mastracode/hooks.json` |
| Amp | its own plugin file, `~/.config/amp/plugins/claxedo-lifecycle.ts` |
| Copilot | inside a tab only, the wrapper writes `.github/hooks/claxedo-notify.json` in the project and adds that path to `.git/info/exclude` once |

Every JSON writer goes through `config-merge.ts`:

- **Only Claxedo's own entries are touched,** recognized by the command of Claxedo's script.
- **The person's text survives.** Their entries, order, formatting and other keys are kept byte for byte, because every change is a text edit.
- **The file is analysed with the same parser that edits it.** Invalid JSON, comments, a byte-order mark, a non-object root, a repeated key, a read-only file or a link to a missing file is refused and left untouched.
- **An unchanged merge writes nothing.**
- **A changed file:**
  - is written atomically, on the link target and with its own mode;
  - is written in place when it has hard links;
  - is merged again if the person changed it after it was read.

## Subagents

A hook that carries `agent_id` or `agentId` belongs to a subagent; Claude and Codex set it only inside one. The parent's turn may end while a subagent still runs.

- **A subagent's ask** marks the tab as waiting, because the person must answer it.
- **Its completion of that same tool** settles the ask.
- **Nothing else a subagent reports changes the tab:** not SubagentStart or SubagentStop, not its Stop, SessionEnd, Interrupt or failure, and not its busy signals.

## Template ownership

The nine CLI declarations live in the bundled `@claxedo/status-hooks` package, which validates them; `src/status-hooks.ts` composes its list. The engine takes the template list as input: `writeStatusHooksArtifacts` writes artifacts and wrappers, `materializeAgentHooks` merges configs through `config-merge.ts`, and `providerLifecycle` maps a raw event with the declaration of the terminal's provider. Project-file installation is shared wrapper machinery.

Templates come only from that bundled package: a plugin manifest that declares `statusHooks` is refused with `PluginStatusHooksRefusedError`, because a template defines shell wrappers and rewrites files in the person's home. `setupAgentHooks({ templates })` and `AgentHookRoutes({ statusHooks })` default to the bundled list; tests pass their own.

Amp declares a guarded text-file install; Antigravity declares a guarded named JSON entry. Droid declares the existing effective-file rule. Conditional event rules preserve native Amp and Antigravity outcomes, while core retains tool-ask pairing, subagent isolation and background-work suppression.

A generic or custom wrapper has no template. It reports `hook_event_name` `Busy`, `Idle` or `Error`, and `providerLifecycle` takes those as the engine's own statuses under the wrapper's command name.
