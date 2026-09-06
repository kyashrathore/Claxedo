# Project Think as the worker runtime: evaluation

Date: 2026-09-05. Compared against [OpenCode v2 workerd](./opencode-v2-workerd-evaluation-2026-09-05.md), the runtime chosen in [plan 003](../plans/2026-09-05-003-opencode-v2-worker-runtime-plan.md). Evidence: the Cloudflare post of 2026-04-15, `@cloudflare/think` 0.17.0 on npm (published 2026-09-03, MIT), the `cloudflare/agents` repository at `main`, and the Cloudflare Agents documentation. Nothing was executed; the gaps are named in section 5.

## 1. What it is

Project Think is a base class, `Think<Env>`, on top of the Cloudflare Agents SDK. You subclass it, override `getModel`, `getSystemPrompt`, `getTools`, and hooks such as `beforeTurn`, `authorizeTurn`, `beforeToolCall`, and the class becomes a Durable Object: one object per agent instance, routed by name, hibernating between events. It is a kit for writing your own agent, not a coding harness you run. `think.ts` alone is 16,329 lines and the package says its API "will continue to evolve in the coming days and weeks."

What is upstream and what you write:

| Concern | Upstream in Think and the Agents SDK | Written by the adopter |
|---|---|---|
| Agentic loop, streaming, stream resumption, client tools | Yes, over the Vercel AI SDK | Nothing |
| Persistence | Sessions: tree-structured messages in DO SQLite, `fork` copying history to a point, non-destructive compaction overlays, FTS5 search, optional Postgres backing | Nothing |
| Memory | Context blocks: writable memory blocks with token limits, skill blocks loaded on demand, search blocks; `set_context`, `load_context`, `search_context` tools generated from providers | Which blocks exist |
| Durable execution | Fibers: `runFiber`, `startFiber` with idempotency keys, `stash` written synchronously to SQLite, `keepAlive`, `onFiberRecovered` after eviction, at-least-once | Recovery handlers |
| Sub-agents | Co-located Durable Object facets with isolated SQLite and typed RPC; no beta flag named in the docs | Child classes |
| Workspace, "Tier 0" | `@cloudflare/shell` `Workspace`: durable virtual filesystem on DO SQLite plus optional R2; tools `read`, `write`, `edit`, `list`, `glob`, `grep`, `delete`; `just-bash` for a virtual shell; `createGit` over `isomorphic-git` with injected auth, so clone, commit and push work without a machine | Which tools are exposed |
| Code execution, "Tier 1 and 2" | `createExecuteTool` runs model-written JavaScript in a Dynamic Worker, with npm resolution through `@cloudflare/worker-bundler` | Requires the `worker_loaders` binding, which is the Dynamic Workers closed beta |
| Extensions | LLM-authored TypeScript tools persisted and loaded through `ExtensionManager` | Same closed-beta dependency |
| Sandbox, "Tier 4" | `createSandboxTools` returns an empty tool set and logs "not yet implemented." The post's bidirectional sync with the Workspace is not in the code. | Everything |
| Channels | Messengers over the Chat SDK, Telegram shipped, plus email, schedules, workflows, MCP client and server | Configuration |
| The agent itself | | System prompt, tool selection, policy, model choice, the harness behavior users see |

Model resolution is open: `getModel` returns a Workers AI slug routed through AI Gateway, or any AI SDK `LanguageModel`, so BYO providers work. Messages are AI SDK `UIMessage`s.

## 2. Evidence quality

Think has workerd execution tests in the repository: `chat-recovery`, `tool-rollback`, `stall-recovery`, `context-overflow-recovery`, `submission-recovery`, `action-pause-recovery`, `workflow-recovery`, `messenger-recovery`, plus fiber eviction tests in the Agents package. OpenCode v2's workerd evidence is a bundle probe. On the specific question "does eviction recovery work on this runtime," Think is ahead.

Against that: the package is at 0.17, marked experimental, and the sandbox tier that the post presents as part of the execution ladder does not exist in code.

## 3. Fit against what the base tier is for

The base tier was defined earlier in this work as non-code sessions that live for years, with a memory layer, zero boot, a machine only as a tool, and GitHub pull requests without a machine. Against that definition:

- **Long-lived assistant with memory.** Think's context blocks, non-destructive compaction and FTS5 are built for exactly this. OpenCode v2 is a coding harness; memory there is a plugin hook and our own store.
- **Channels.** Telegram, email and schedules are upstream in Think. The channels layer in this repository is still a plan.
- **Pull requests without a machine.** `isomorphic-git` over the durable workspace gives clone, commit and push in the object, broader than the Git Data API plugin in plan 003.
- **Machine as a tool.** Think has nothing here today. Every machine path is Claxedo code: a tool that leases through the sandbox manager and spawns a child session running OpenCode or Pi, with the result returned as a tool output. That is the child-session model, and the boundary is a tool result, so the AI SDK message format never has to convert to a harness format.
- **Coding in the worker without a machine.** Both give read, edit, grep and write over a virtual filesystem. Neither runs a real process without a machine; Think's code execution tier needs the closed beta.
- **One harness across placements.** OpenCode v2 has it. Think does not, and does not try to.

## 4. What Claxedo would own with Think

The `Think` subclass: prompt, tools, policy hooks, model policy. The machine tool over the sandbox manager and the child-session spawn into a sandbox harness. The gateway, unchanged. The channels configuration. The memory block definitions. Roughly the same footprint as plan 003's object class, driver and plugins, minus the workspace driver and exec channel, plus the child-session spawn. Claxedo becomes the author of the base-tier agent, which is product code rather than harness internals, because the loop, persistence, recovery, compaction, workspace and git are upstream.

## 5. What is not verified

- Time to first token on a cold and warm object.
- Whether sub-agent facets work on the account without the Dynamic Workers beta. The docs name no flag; the earlier Cloudflare post placed facets in beta for Workers Paid.
- Workspace size limits on SQLite and R2, and `isomorphic-git` performance on real repositories.
- API churn rate over the next weeks.

## 6. Verdict

**Owner ruling, 2026-09-05, after this evaluation:** Claxedo is a layer over harnesses and must not own harness internals. Think requires the adopter to write the agent (prompt, tools, policy, memory blocks, compaction registration), which makes Claxedo the harness. Think is therefore rejected for the base tier regardless of the spike below. A bootless tier is allowed only through a harness that ships its own bootless profile, which today is OpenCode v2 workerd (plan 003); otherwise plan 004 applies. The analysis below is kept as the record of why.

Think is not a replacement for OpenCode v2 as a coding runtime. It is a strong candidate for the base tier as it was actually defined: a long-lived assistant with memory and channels, where coding is a tool that hands work to a sandbox harness.

The choice therefore turns on one product question: does the worker session need to run real coding tools on a machine without leaving the session? If yes, plan 003 stands, because `WorkspaceDriver` is the only upstream seam that does it. If the worker session is the assistant and machine work is always a child session in a sandbox, Think fits the definition better and gives memory, channels, sessions, recovery and git for free.

Recommended gate: run both spikes side by side, one week.

1. Plan 003 Unit 1 as written.
2. A Think spike: subclass with one writable memory block, workspace read and edit, `isomorphic-git` clone of a small private repository through the gateway, a `request_machine` tool that leases a sandbox and spawns an OpenCode child session returning a report, evict, resume. Record boot and first-token times and every place the code touched the closed beta.

Decide on the numbers, the recovery behavior observed, and the answer to the product question above. Until then plan 003 stands.
