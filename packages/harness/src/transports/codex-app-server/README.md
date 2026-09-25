# Codex app-server transport

This transport uses Codex's JSON-RPC app-server over stdio. It carries native `turn/steer`, `thread/goal/*` goals and provider-started turns, thread recovery, usage, and quota windows. ACP does not expose those native operations. A process belongs to one session and is started only through `services.spawn`; retirement uses the returned owned-process handle. The broker owns request persistence and grants before any answer goes back to Codex.
