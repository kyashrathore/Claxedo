# ACP transport

ACP gives a client one standard way to hand an agent tools: the `mcpServers` list at `session/new`, `session/load` and `session/resume`. Nothing in the protocol carries skills, plugins, slash commands or instructions from the client, and nothing updates a running session's MCP servers. A server added later reaches the agent only when the session is loaded or resumed again with the full list, which may restart the agent's own process.

Claude plugins are the one exception this transport delivers. `@agentclientprotocol/claude-agent-acp` passes `_meta.claudeCode.options` straight to the Claude Agent SDK, and has done since 0.10.9, so its `plugins` option carries whole plugin roots. The handshake's `agentInfo` must report that package name and at least that version. Any other agent that receives plugin roots is refused rather than silently given MCP servers alone. A remote agent never receives local plugin paths.

Every agent examined also reads its own global configuration over ACP (`~/.claude`, `~/.codex/config.toml`, Gemini's settings), so the servers a person configured locally reach it alongside the ones Claxedo passes.
