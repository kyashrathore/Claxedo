# Cursor profile

The pinned Cursor SDK creates local agents with `Agent.create({ local: { cwd } })`. Its `settingSources` option can read `"plugins"` only from the machine's `~/.cursor/plugins/local` layout. There is no per-session plugin directory option, so this profile refuses projected plugin roots before starting or reconfiguring a session. Source: `@cursor/sdk@1.0.24` `dist/esm/options.d.ts` (`LocalAgentOptions.settingSources`) and the existing product Cursor adapter.

The SDK accepts stdio, HTTP and SSE MCP servers in `Agent.create` and `Agent.send`. The profile passes projected servers and the first-party local MCP server by name, rejecting duplicate names. Source: the pinned SDK's `McpServerConfig` and `AgentOptions`/`SendOptions` in `dist/esm/options.d.ts`.
