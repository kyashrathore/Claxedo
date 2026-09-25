# Codex app-server transport

This transport uses Codex's JSON-RPC app-server over stdio. It carries native `turn/steer`, `thread/goal/*` goals and provider-started turns, thread recovery, usage, quota windows, and `model/list` discovery. ACP does not expose those native operations. A process belongs to one session and is started only through `services.spawn`; retirement uses the returned owned-process handle. The broker owns request persistence and grants before any answer goes back to Codex.

Owner-login ChatGPT token refresh reads and rotates the owner's Codex auth file. Brokered accounts use the configured API-key placeholder and reject ChatGPT refresh with JSON-RPC `-32000`. Dynamic tool calls return Codex's `success: false` tool result because this transport does not advertise dynamic tools or subagents. Unexpected request methods return `-32601`; handler failures remain `-32603`.

Stop, pause, and cancel treat Codex's `no active turn to interrupt` response as a completed interrupt. Turn-owned background terminals are identified from command events, listed across pages, terminated, and read back. A turn with no observed command process has unknown cleanup because the transport has no terminal inventory tied to that turn.
