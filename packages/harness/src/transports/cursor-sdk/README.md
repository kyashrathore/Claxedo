# Cursor SDK transport

The pinned SDK reads `CURSOR_BACKEND_URL` as its module loads and does not expose an agent-specific backend option. This transport keeps one `worker_threads` worker per backend binding. Each worker loads its own SDK module after receiving its own environment, and sends SDK messages over a `MessagePort`. An SDK run error fails only its own turn. A worker crash or expired command fails every pending call on that worker; the next turn starts a new worker for the binding and resumes its agent.

The worker receives a broker-signed placeholder for a bound account. The egress broker exchanges the real key, keeps the real access token, and returns that signed placeholder in the exchange reply; subsequent Connect calls are substituted inside the broker. With no product binding, only a machine-owner local session can use the machine's explicit `CURSOR_BACKEND_URL` and `CURSOR_API_KEY`.

The native SDK carries run status, usage and tools through `Agent.create` and `Agent.send`. ACP does not expose these SDK calls. The transport uses the existing Cursor translator in `@claxedo/agent-event-runtime`; the SDK owns its own loop and tools. The SDK exposes no child identity that this transport can admit, so subagents are not advertised.
