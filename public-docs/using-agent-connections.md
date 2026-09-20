# Using an ACP Agent in Claxedo

This guide is for someone who wants to run an external coding agent inside
Claxedo. Claxedo ships native harnesses for Claude, Codex, Cursor, Pi and
OpenCode. Anything else reaches Claxedo through an **agent connection**: a
command Claxedo starts on your machine and talks to over the Agent Client
Protocol (ACP). The agent keeps its own login, its own models and its own
tools; Claxedo gives it a workspace, a transcript, permissions and a place in
the sidebar.

The reference for every field and route is
[Agent Connections](./acp-connections.md). This page is the order you do
things in, what you get, and what you do not get.

## What you need before you start

1. **The agent's own CLI, installed and logged in.** Claxedo does not install
   agents and does not sign in for them. For Cursor that is `cursor-agent`
   with `cursor-agent login` done once; Claxedo then runs `cursor-agent acp`
   on that login. Claude Code and Codex have ACP entry points of their own.
   Whatever the agent needs (its API key, its subscription login, its config
   file) lives with the agent, not in Claxedo.
2. **A binary Claxedo can find.** A connection is spawned directly, with no
   shell. A bare command name is looked up on the server's `PATH`; the desktop
   app adds `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` to that
   `PATH` on macOS (and `~/.local/bin`, `/usr/local/bin`, `/usr/bin` on
   Linux). A binary anywhere else needs an absolute path in `command`.
3. **The data directory of the build you run.** The desktop app keeps one
   directory per release channel: `~/.claxedo/` for `prod`, `~/.claxedo-beta/`
   for `beta`, `~/.claxedo-dev/` for `dev`. `CLAXEDO_DATA_DIR` overrides it.
   A connection added to the wrong directory is invisible to the app you are
   looking at.

## Add the connection

There is no "add agent" form in the app. Settings → Connections lists what is
configured, shows whether each row is Ready or Disabled, and can remove a row.
Adding or changing a connection is an operator action, so that command lines,
environment variables and secret references never pass through the browser.

Write the connection into `user-agent-config.json` in the data directory
above. The smallest useful file for Cursor:

```jsonc
{
  "version": 3,
  "mcp": {},
  "connections": {
    "cursor-acp": {
      "connectionId": "cursor-acp",
      "providerKey": "acp",
      "configRevision": 1,
      "enabled": true,
      "config": {
        "label": "Cursor (ACP)",
        "connection": {
          "kind": "process",
          "command": "/Users/me/.local/bin/cursor-agent",
          "args": ["acp"]
        }
      }
    }
  },
  "sandbox_driver": {}
}
```

Rules that the file enforces:

- The map key and `connectionId` are the same string, and the id is permanent.
  Pointing an existing id at a different binary is refused; make a new id.
- Every edit to a connection needs a higher `configRevision`. A revision that
  goes backwards is refused.
- The server watches the directory. A saved file reaches the running
  workspaces within about a second; a file that does not parse is ignored until
  it parses again, and the previous connections keep working.
- If the agent needs a secret in its environment, do not write the value in
  the file. Name it under `secretBindings.env` and point `secretRefs` at an
  entry in Claxedo's credential store; the value is resolved on this machine
  immediately before the agent starts and is never written back to the file.
- To stop forwarding Claxedo's MCP servers to this agent, add
  `"supportsMcpServers": false` inside `config.connection`.

The same descriptor can be sent with `PUT
/api/claxedo/agent-config/connections/<connectionId>` on the local server from
the machine itself; the route refuses callers that are not on loopback.

Once saved, open Settings → Connections. The row should read **Ready**. If the
row is missing, the file did not parse: the server's log names the problem.

## Choose when the agent is used

**For one conversation.** Open the harness and model picker in the composer
(the control that names the current agent). Every enabled connection is listed
beside the native harnesses. Pick it before the first message. The app
remembers that choice for new drafts in the same workspace on this device.

**For everything by default.** Set `"defaultConnectionId": "cursor-acp"` at
the top level of the same file. It must name an installed, enabled
connection, and it cannot be combined with a native `defaultHarness`. New
sessions that do not choose otherwise start on it. This default is global to
the machine; there is no per-workspace default on the server side.

**In the middle of a conversation.** When no turn is running you can switch a
session to a connection, or away from one, from the same picker ("Continue
this conversation with another harness"). Claxedo hands the transcript so far
to the new agent as a system block on its first turn. Any permission answers
you had marked "always" on the old agent are forgotten by the switch.

## What a turn looks like

- **Instructions** (Claxedo's standing instructions, a handoff transcript,
  and anything a feature adds for the turn) go to the agent as the first
  content block of the prompt, marked for the assistant. ACP has no separate
  system channel, so an agent that ignores annotated blocks sees them as part
  of the user's message.
- **MCP servers** you configured in Claxedo, plus Claxedo's own per-session
  server, are handed to the agent when the session is created, forked or
  resumed, unless the connection opts out.
- **Attachments** are written into `<workspace>/.claxedo/attachments/` (git
  ignored, readable only by you) and named in the prompt text. Images go
  inline when the agent accepts inline images; other files go inline when the
  agent accepts embedded content, otherwise as a link to that path. An agent
  that accepts neither and does not share your filesystem cannot take an
  attachment at all; the turn fails rather than dropping the file.
- **The working directory** the agent works in is the workspace or worktree
  you opened, passed on every session request. The agent process itself is
  started in the server's own directory, so an agent that only trusts its
  process directory will be looking at the wrong folder; well-behaved ACP
  agents use the session's `cwd`.
- **Models.** If the agent exposes a model option or a model list, the
  composer's model picker shows it and selecting one restarts the agent
  process with that model. Many agents manage their model themselves; then
  the picker shows nothing to choose and the turn runs on whatever the agent
  decides.
- **Goal mode** (autonomous continuation) works only with agents that
  negotiate Claxedo's Goal extension at session creation. Otherwise the Goal
  controls say the agent did not negotiate it.

## Permissions

Every permission request the agent sends is shown in the permission dock with
the agent's own title, the command for a shell request, the reason for
anything else, and the paths the agent named. You answer **Allow once**,
**Allow always** or **Deny**.

- "Always" is remembered per session, keyed by the tool kind and the exact
  title the agent sent. The next identical request is answered for you and
  shows up in the transcript as answered, without a prompt. It survives
  restarting the app and the server. A compound shell command is a new title
  every time it changes, so a program-level allowlist has to come from the
  agent. A request with no title is never remembered.
- **Approve for me** (the "Auto" toggle in the composer) is Claxedo's own,
  agent-independent rule: it auto-approves searches, thinking and in-project
  edits, and still asks you for deletes, moves, shell commands, network
  fetches and mode changes.
- **Permission modes** come from the agent. If it exposes a mode option (or
  ACP session modes), the mode picker lists them with the agent's own names and
  descriptions, and a change applies from the next turn. If the agent exposes
  neither, the picker says so. If an agent refuses the mode you asked for, the
  turn fails and says which mode the agent kept.
- Cancelling a turn answers every open permission as cancelled.

## What an ACP agent cannot do here

| Area | What happens |
|---|---|
| Parallel turns | One turn at a time per agent process. Sessions in the same workspace on the same connection share one process and queue behind each other. |
| Process loss | If the agent exits mid-turn, the turn fails with the agent's last error line, every session on that process is marked recovering, and the next turn starts a fresh process. Nothing is retried for you. |
| Restart and resume | After the server restarts, the next turn asks the agent to resume its own session. An agent that cannot resume or load sessions fails that turn; only "not found" starts a fresh agent session automatically. Claxedo's transcript is always kept. |
| Questions, todos, slash commands, revert, subagents | Not offered as controls. Plans the agent publishes are still rendered as a todo list, and command lists it publishes are shown, but you cannot answer a structured question, revert a step or spawn a subagent through Claxedo. |
| Fork | Only if the agent itself supports session fork. |
| Effort levels | None; the agent decides. |
| Instructions | A prompt prefix, not a system channel (above). |
| Environment | The agent inherits your environment minus every `CLAXEDO_*` and `WORKSPACE_RUNTIME_*` variable that is not on Claxedo's allowlist, and minus anything ending in `_TOKEN`, `_SECRET`, `_KEY`, `_PASSWORD`, `_CREDENTIALS` or `_PEM`. |
| Where it runs | A connection lives on the machine that runs the agent. A workspace on another machine you own uses that machine's own connection file and credential store. A connection that names secrets runs only on a desktop or local server; runtimes that receive their configuration by broadcast refuse it. |
| Configuration UI | Read-only list plus Remove. Adding and editing is the file or the local API. |
| Signed and hosted shells | The hosted web app cannot configure connections; it shows "Agent connections are configured by the operator on the local host." |

## Time limits

A turn has no wall-clock limit. What ends it is silence: the agent sending
nothing for the prompt timeout while nothing is waiting on you. A permission
request you have not answered holds the clock; a streaming tool call keeps it
alive.

| Variable | Default | Bounds |
|---|---|---|
| `CLAXEDO_ACP_PROMPT_TIMEOUT_MS` | 300000 | Silence inside a turn; on expiry the agent session is cancelled and the process replaced |
| `CLAXEDO_ACP_IDLE_TIMEOUT_MS` | 300000 | A process with no turn running (read once at server start) |
| `CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS` | 10000 | Creating, resuming and loading a session, mode changes, the per-turn sync |
| `CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS` | same as new-session | The `initialize` handshake |
| `CLAXEDO_ACP_PROBE_TIMEOUT_MS` | same as new-session | Discovering models and modes |

Set them in the environment of the server (for the desktop app, the
environment it is launched with).

## When something goes wrong

The agent's own stderr is written to the server log: on the desktop app,
`server.log` next to `main.log` in the app's log directory
(`~/Library/Logs/<app name>/` on macOS). The last stderr line is also attached
to the error you see.

| What you see | What it means | What to do |
|---|---|---|
| Row missing from Settings → Connections | The file did not parse, or you edited the other channel's directory | Check the server log for `connections:` problems; check the data directory |
| `Connection "<id>" is not configured on this runtime` | The workspace runtime has no applied descriptor for that id: it is disabled, was removed, or names a secret this runtime cannot resolve | Enable it, or run the workspace on the machine that holds the secret |
| `ACP initialize timed out` / `ACP newSession timed out after 10000ms` | The binary started but did not answer the handshake or session creation in time; usually the agent is not logged in, is waiting on a first-run prompt, or the wrong binary was named | Run the agent's own CLI once in a terminal; raise `CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS` for a slow cold start |
| `ACP transport exited with code N: <last stderr>` | The agent process died during a turn | Read the stderr line; the next turn starts a new process |
| `ACP prompt timed out after 300000ms of inactivity` | The agent went silent for five minutes with nothing waiting on you | Retry; raise `CLAXEDO_ACP_PROMPT_TIMEOUT_MS` for agents that think for long stretches without streaming |
| `<Agent> runtime is unavailable` in the composer | The app's probes of the runtime kept failing after several retries | Use Retry; if it persists, read the server log for the cause |
| `ACP agent does not advertise session resume or load support` | After a restart the agent cannot pick up its old session | Start a new session; the old transcript stays readable |
| `ACP agent cannot receive a <mime> attachment` | The agent accepts no inline content and shares no filesystem | Paste the content, or use an agent that runs on your machine |
| `ACP kept permission mode X instead of Y` | The agent refused the mode you selected | Pick one of the modes it reports |
| `Wait for the current turn to finish before switching harness` | A harness switch was asked mid-turn | Stop the turn or wait |

## What stays on your machine

The browser only ever receives a connection's id, label, enabled flag,
readiness, capability flags and model policy. Command lines, arguments,
environment, headers, secret references and resolved secrets stay on the host
that runs the agent, and the management routes answer only loopback callers.
Process identities that leave the host are hashed fingerprints, never the
launch command.
