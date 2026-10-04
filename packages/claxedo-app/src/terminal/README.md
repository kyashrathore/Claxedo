# Terminal

Owns: terminal panes, the one attach path to a runtime PTY, terminal links, the per-placement terminal list, agent status in terminals, and the phone key row.

## Owned concepts

- **Terminal row** (`model.ts`): a server `Terminal` plus its `agentStatus`. The list per placement lives in one store (`store.ts`), filled by `server.terminals.list` and kept current by the stream's `terminalCreated`, `terminalUpdated`, `terminalExited`, `terminalRemoved` and `terminalAgentStatusChanged` events. A `streamGap` (a daemon restart is one) re-reads the list and drops the rows it no longer names, keeping any created during the read. Nothing else holds rows. The rail reads a placement's list only while its project is expanded and the placement is live (the catalog's `reachable`: a running sandbox, a machine that serves it, or this machine), so a collapsed project, a stopped sandbox or an offline machine costs no PTY read.
- **Terminal pane** (`pane.ts`): the `terminal` pane kind. Its state is `{ placementId, terminalId }`, and its route is `/w/:placementId/terminal/:terminalId`, so a reload or a deep link reopens the same PTY.
- **Attach** (`attach.ts`): the only way a pane reaches a PTY. It attaches with the last output cursor it wrote. The runtime answers with a `cursor` frame, which may carry a screen checkpoint, then replays the output after that cursor. The runtime's replay is the only replay; the app keeps no second copy of terminal output. Output goes through the write queue (`write-queue.ts`), which disconnects a stream whose pending output passes 128 MiB rather than freeze the window. Input passes through `input-reply-filter.ts`, so xterm's answers to capability queries are not echoed back as typing.
- **Resize** (`resize.ts`): sizes are published after the host settles, never for a host smaller than 48 × 32 px, and agent TUIs (`isLikelyTui`) get a SIGWINCH toggle after a desync, so the TUI redraws at the real size.
- **Links** (`links/`): file paths (with `:line:col` suffixes), URLs, links wrapped across lines, and the fallback formats compilers print. A file link opens the `file` pane at the line, relative to the terminal's working directory; a path outside it is not opened.
- **Backend** (`backend/`): xterm with clipboard, keyboard, drop, input-mode reclaiming after a TUI exits, and a renderer budget of at most 12 WebGL contexts, with the DOM renderer past that and on phones. It loads lazily through the `#terminal-backend` alias.
- **Key row** (`view/accessory-row.tsx`): Esc, Tab, Ctrl (armed until the next key) and arrows, shown on a phone or a coarse pointer while the terminal has focus.

## State machines

- **Connection** (`model.ts`): `connecting → attached`. A retriable close moves to `detached(attempt)`, which reconnects on its own with a 1 s to 16 s backoff for six attempts, after checking the terminal still exists. `failed(failure)` waits for the user: the attempts ran out, the stream closed for good, the output overloaded, the checkpoint could not be restored, or the backend could not start. `ended` means the shell exited or the runtime no longer has the PTY; the pane then drops the terminal's row, so the terminal leaves the rail, its pane and the compact tabs together, as in v1.
- **List load** (`model.ts`): `idle → loading → ready | failed`. The store's rows are the one list of live terminals: the rail lists them, and `useCloseEndedTerminals` (`close.ts`) closes every workbench content (pane or compact tab) whose terminal is absent from a `ready` list, as v1 drops dead terminals. That covers a content restored after the daemon restarted and a shell that exited.

## Invariants

- Closing a terminal tab ends its PTY: the provider listens to the workbench's `onClosed` for the `terminal` kind and removes the terminal on the server. The store treats the server's `not_found` answer as ended and drops the row, so closing a terminal that already died clears it from the rail too. A failure to end it is logged and shown.
- `TerminalProvider` mounts once inside the scoped shell, under the commands provider, because it reads the route, the workbench and the command registry. It owns the stores, at most 8 placements, and never evicts a placement a mounted pane retains.
- The placement a new terminal opens in is the one the URL names.
- A terminal is the workspace's, never a session's: it is created with no session on every placement, and the runtime admits any workspace token with write access to every terminal on it. A refusal arrives as the `forbidden` error class with its own copy, never as a sign-in failure.
- Status copy comes from the failure reason, never from an error's message.

## Creating terminals

The terminal creator (`creator-pane.ts`, `view/terminal-creator.tsx`) is v1's "Start a terminal" card in a workbench pane titled "New Terminal": a tile for the login shell and one per agent CLI (`agents.ts`, `launchers.ts`: Claude, Codex, Cursor, Gemini) from the launcher catalog; the placement's shell runs the chosen command and shows its outcome. A tile creates the terminal with its command, titled "<name> N", and replaces the creator with it.

`useTerminals()` (`public.ts`) is the domain's public API: `items(placementId)` (id, title, agent status), `retain(placementId)` while a list is on screen, `createTerminal(placementId, launch?)`, `open`, `close` (closes its pane, which ends the shell, or ends it directly) and `startNew(placementId)`, which opens the creator.

## Commands

`terminal.new` ("New terminal", `ctrl+alt+t`) closes the workspace panel, creates a terminal in the current placement and opens it. `terminal.toggle` ("Toggle terminal", `ctrl+\``) closes the focused terminal, or opens a new one when none has focus.

## Flows

Flow 13 (run a command, reload and replay, a TUI exit leaves no mouse garbage, a multi-line link opens the file at the line, agent status) and flow 33 (phone).
