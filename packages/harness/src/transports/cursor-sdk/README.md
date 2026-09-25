# Cursor SDK transport

The pinned SDK reads `CURSOR_BACKEND_URL` as its module loads and does not expose an agent-specific backend option. This transport keeps one `worker_threads` worker per backend binding. Each worker loads its own SDK module after receiving its own environment, and sends SDK messages over a `MessagePort`. A failed SDK run or a crashed worker fails its turn; the registry retires that worker, and the next turn starts a new worker for the binding.

The worker receives a broker-signed placeholder for a bound account. The egress broker exchanges the real key, keeps the real access token, and returns that signed placeholder in the exchange reply; subsequent Connect calls are substituted inside the broker. When there is no product binding, the worker inherits the machine owner's explicit `CURSOR_BACKEND_URL` and `CURSOR_API_KEY`.

The native SDK carries run status, usage, tools and plugin settings through `Agent.create` and `Agent.send`. ACP does not expose these SDK calls. The transport uses the existing Cursor translator in `@claxedo/agent-event-runtime`; the SDK owns its own loop and tools.
