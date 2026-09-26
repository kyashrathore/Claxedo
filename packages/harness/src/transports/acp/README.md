# ACP transport

ACP gives a client one standard way to hand an agent tools: the `mcpServers` list at `session/new`, `session/load` and `session/resume`. Nothing in the protocol carries skills, plugins, slash commands or instructions from the client, and nothing updates a running session's MCP servers. A server added later reaches the agent only when the session is loaded or resumed again with the full list, which may restart the agent's own process.

Claude plugins are the one exception this transport delivers. `@agentclientprotocol/claude-agent-acp` passes `_meta.claudeCode.options` straight to the Claude Agent SDK, and has done since 0.10.9, so its `plugins` option carries whole plugin roots. The handshake's `agentInfo` must report that package name and at least that version. Any other agent receives the MCP servers alone; the plugin roots are reported as not applied (`unsupported-by-harness`, "this ACP agent accepts MCP servers only") through a `harness-notice` on the session broker, because a custom ACP agent is a target for MCP servers and the session must still start. A remote agent never receives local plugin paths.

The chosen model, effort and permission mode reach the agent before each prompt through `session/set_config_option` (or `session/set_mode` for an agent that publishes only the `modes` channel), and the agent picker through `config.update`, since the `mode` channel serves both the agent choice and the permission mode. A value the agent answers with a different current value is a refusal, never a turn run on something the picker never showed. Attachments follow the negotiated `promptCapabilities`: images inline, audio inline, other bytes as an embedded resource, and every file also written to the workspace (through the shared materializer) with a `resource_link` when the connection declares `sharedFilesystem`; a part the agent cannot take fails the turn before the prompt.

A session title is a throwaway `session/new` on the same agent whose chunks are collected off the main transcript; the side session's requests are answered `cancelled` and its updates never reach a turn.

A configure that arrives during a turn restarts the agent only after that turn has settled. The restart runs outside the turn: its failure goes to `SessionBroker.reportFailure`, the next turn or configure waits for it and is refused with the restart's reason once it has failed, and a later `start` or `attach` clears the record. A cancel is bounded by its caller's deadline, or by 5 seconds for an abort and the quiet timeout, so a hung write cannot keep a session busy; a cancel with no turn active writes nothing.



Every agent examined also reads its own global configuration over ACP (`~/.claude`, `~/.codex/config.toml`, Gemini's settings), so the servers a person configured locally reach it alongside the ones Claxedo passes.

`streams.ts` adapts the agent process's Node streams to the web streams `ndJsonStream` takes, with the global `ReadableStream` and `WritableStream` constructors. `Readable.toWeb` returns `node:stream/web` types, and a package that compiles this source with the DOM library (as `workspace-runtime` does) sees the SDK's parameters as the DOM's types, which that return type doesn't satisfy. The reader pulls one chunk per request, so a slow consumer applies backpressure to the agent's output.
