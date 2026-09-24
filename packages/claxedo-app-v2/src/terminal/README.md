# Terminal

Owns: terminal panes, the one attach path to a runtime PTY, terminal links, the per-placement terminal list, agent status in terminals, and the phone key row.

## Owned concepts

- **Terminal row** (`model.ts`): a server `Terminal` plus its `agentStatus`. The list per placement lives in one store (`store.ts`), filled by `server.terminals.list` and kept current only by the stream's `terminalCreated`, `terminalUpdated`, `terminalExited`, `terminalRemoved` and `terminalAgentStatusChanged` events. Nothing else holds rows.
- **Terminal pane** (`pane.ts`): the `terminal` pane kind. Its state is `{ placementId, terminalId }`, and its route is `/w/:placementId/t/:terminalId`, so a reload or a deep link reopens the same PTY.
- **Attach** (`attach.ts`): the only way a pane reaches a PTY. It attaches with the last output cursor it wrote. The runtime answers with a `cursor` frame, which may carry a screen checkpoint, then replays the output after that cursor. The runtime's replay is the only replay; the app keeps no second copy of terminal output. Output goes through the write queue (`write-queue.ts`), which disconnects a stream whose pending output passes 128 MiB rather than freeze the window. Input passes through `input-reply-filter.ts`, so xterm's answers to capability queries are not echoed back as typing.
- **Resize** (`resize.ts`): sizes are published after the host settles, never for a host smaller than 48 × 32 px, and agent TUIs (`isLikelyTui`) get a SIGWINCH toggle after a desync, so the TUI redraws at the real size.
- **Links** (`links/`): file paths (with `:line:col` suffixes), URLs, links wrapped across lines, and the fallback formats compilers print. A file link opens the `file` pane at the line, relative to the terminal's working directory; a path outside it is not opened.
- **Backend** (`backend/`): xterm with clipboard, keyboard, drop, input-mode reclaiming after a TUI exits, and a renderer budget of at most 12 WebGL contexts, with the DOM renderer past that and on phones. It loads lazily through the `#terminal-backend` alias.
- **Key row** (`view/accessory-row.tsx`): Esc, Tab, Ctrl (armed until the next key) and arrows, shown on a phone or a coarse pointer while the terminal has focus.

## State machines

- **Connection** (`model.ts`): `connecting → attached`. A retriable close moves to `detached(attempt)`, which reconnects on its own with a 1 s to 16 s backoff for six attempts, after checking the terminal still exists. `failed(failure)` waits for the user: the attempts ran out, the stream closed for good, the output overloaded, the checkpoint could not be restored, or the backend could not start. `gone` means the runtime no longer has the PTY; `exited(code)` means the shell ended. Both offer to recreate the terminal in the same pane.
- **List load** (`model.ts`): `idle → loading → ready | failed`. A pane whose terminal is absent from a `ready` list shows that the terminal no longer exists.

## Invariants

- Closing a terminal tab ends its PTY: the provider listens to the workbench's `onClosed` for the `terminal` kind and removes the terminal on the server. Replacing a gone terminal's pane fires the same hook, and the server's `not_found` answer for it is the expected end state. A failure to end it is logged and shown.
- `TerminalProvider` mounts once inside the scoped shell, under the commands provider, because it reads the route, the workbench and the command registry. It owns the stores, at most 8 placements, and never evicts a placement a mounted pane retains.
- The placement a new terminal opens in is the one the URL names.
- Status copy comes from the failure reason, never from an error's message.

## Commands

`terminal.new` (`mod+shift+\``) creates a terminal in the current placement and opens it.

## Flows

Flow 13 (run a command, reload and replay, a TUI exit leaves no mouse garbage, a multi-line link opens the file at the line, agent status) and flow 33 (phone).
