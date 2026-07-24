// The adapter spawns `codex` from PATH (CODEX_PATH unset): the user's system
// install, mirroring how the Claude harnesses resolve `claude`. The desktop
// main prepends standard install dirs to PATH (agent-path.ts) so GUI launches
// still find it.
await import("@agentclientprotocol/codex-acp")
