# The harness layer: first principles and rebuild plan

**Status:** planned, not started.
- Written 2026-09-24; revised 2026-09-25 three times: after GPT-6 Astra's review, after its re-review and a five-part adversarial review of the code, and to add this first-principles part.
- [Appendix B](#appendix-b-review-findings-and-what-changed) lists the review findings and what changed.
- Measured on `dev` at `37563dc802`; [Appendix C](#appendix-c-measurements) gives the commands.

**Sources:**
- the harness file-level review, `~/Downloads/Claxedo — how it works/97 Part C/harness.md`;
- the line-budget plan, `97 Reducing Claxedo to 150k lines — plan.md`;
- a read of the code.

Where the code disagrees with the file-level review, the code wins. For example, `adapters.ts`, `log.ts`, `target.ts` and `paths.ts` are live, and the recovery engine is needed.

**Sibling plan:** [App rebuild: the first proof](2026-09-24-001-refactor-app-rebuild-first-proof-plan.md). This plan keeps its promise of unchanged server contracts.

**This document has two parts:**
- **Part 1** says what the harness layer is for, what's wrong with it, whether that needs solving, what could be better, and the beliefs and principles behind every later choice.
- **Part 2** is the plan.

# Part 1: First principles

## What the harness layer is

Claxedo is a layer over agent harnesses: Claude Code, Codex, Cursor, Pi, OpenCode, and any agent that speaks ACP. A person works in a Claxedo session. A harness does the actual agent work: its own loop, tools, memory and compaction. **The harness layer is everything between the two.**

It has to:
- start or reach the harness, wherever it runs;
- give it the right credentials, MCP servers, skills and plugins;
- send it the person's turns;
- turn its native stream into Claxedo's events;
- bring its questions to the person and their answers back;
- and survive the harness crashing, the machine restarting, and the network dropping.

It doesn't own what the harness does. That's the owner's rule: Claxedo layers over harnesses and never owns their internals.

## The core responsibilities

These are the jobs the layer does, whoever owns them today. Each gets exactly one owner after the rebuild.

| # | Responsibility | What it means | Differs per harness in | Owner after |
| --- | --- | --- | --- | --- |
| 1 | **Harness registry** | Which harnesses exist: built-in (Claude, Codex, Cursor, OpenCode) and custom (any ACP agent, Pi). What each can do. **Today there are four separate harness lists:** `AGENT_HARNESS_DEFINITIONS`, `harness-table.ts`, the plugin `harness-registry.ts`, and `MCP_CAPABLE_AGENTS` | capabilities, declared from the harness's own handshake where it has one | `src/registry/`, `src/capabilities/` |
| 2 | **Connection setup** | Validating a custom harness entry (command or URL, headers, secrets, model choice), its immutable identity, and resolving its secrets into a lease | process versus remote; which secrets go in the environment and which in headers | `src/registry/` (the five `CustomHarnessProvider` hooks) |
| 3 | **Where it runs** | Local on this machine, in a cloud sandbox, or remote on someone else's machine. This decides what can reach the harness ([Where a harness runs](#where-a-harness-runs)) | — | `StartInput.locality`, set by the registry |
| 4 | **Process lifecycle** | Starting a harness process, owning it, observing it, retiring it, and proving it stopped, across restarts and on Windows | the Claude SDK starts `claude`; Codex runs `codex app-server --listen stdio://`; ACP starts a command over stdio or dials websocket or HTTP; Pi runs `pi --mode rpc`; Cursor's SDK runs in-process; OpenCode's engine runs inside the daemon | `packages/process-ownership`, used only through `services.spawn` |
| 5 | **Credentials** | Getting the person's selected provider account to the harness in the form the harness reads, without handing out the secret where avoidable | environment variables, config files (Codex `config.toml`, Pi `models.json`), SDK options, placeholders the broker fills | `src/registry/` credentials, plus each transport's `credentials.ts` |
| 6 | **Session lifecycle** | Creating the harness's own session, reattaching after a restart, rebinding when the harness changes its id, closing | native session ids, resume calls (`resume`, `thread/resume`, `session/load`, `--session <file>`) | the transport (`start`, `attach`, `close`), with `SessionBroker.rebind` |
| 7 | **Turn execution** | Sending a turn, streaming it, steering it mid-turn, cancelling it, and turns the harness starts itself (Codex goal turns) | `query()`, `turn/start`, `session/prompt`, RPC prompt, HTTP; `turn/steer` or streaming input; each protocol's cancel | the transport (`send`, `steer`, `cancel`), with `SessionBroker.admitProviderTurn` |
| 8 | **Event translation** | Turning the harness's native stream into Claxedo's `AgentRuntimeEvent`s, and routing child-session events | SDK messages, 65 Codex notification methods, ACP `session/update`, Pi RPC lines, OpenCode engine events | each transport's `translate/`, a pure function of state and event |
| 9 | **Requests** | Permissions, questions and elicitations: bringing them to the person, grants ("allow always"), permission-mode limits, saving before releasing, cancelling | `canUseTool`, Codex server requests, ACP `request_permission` and elicitation, Pi extension UI, OpenCode `permission.asked` | `src/broker/`; who may answer stays in the routes' access policy |
| 10 | **Config and capabilities** | Models, effort, permission modes; applying changes on the right timing; reads before a session exists | next turn versus next session; what a mode's `level` is | the transport's `config` group, plus `configure` |
| 11 | **Goals** | Native goals (the harness runs them) and evaluated goals (Claxedo checks the work) | Codex `thread/goal/*`, Claude and Cursor `/goal` prompts, an ACP goal extension, none | the transport's `goals` group; the evaluated loop in the runtime host |
| 12 | **Subagents** | Seeing child agents, mapping them to child sessions, attributing usage | SDK task events, Codex collab calls, ACP draft #1992 | `src/broker/` |
| 13 | **Usage** | Per-turn usage, quota windows, usage that arrives after a turn ends | where each harness reports it | `src/broker/` (`TurnBroker.meter`, `SessionBroker.meter`) |
| 14 | **Naming** | Titles and renames | a side request, or the harness's own name | the runtime host decides when; the transport's `naming` group does it |
| 15 | **Projection: skills, MCP servers, plugins** | Putting the person's tools into the harness the way *that harness* documents | plugin folders, a Codex marketplace, `~/.cursor/plugins/local`, OpenCode's host hooks, Pi flags; delivered by SDK option, file or protocol | `src/profiles/` (format), each transport (delivery) |
| 16 | **MCP resolution** | Which MCP servers a session gets: Claxedo's own, the person's configured ones, plugin ones; and what may reach a remote harness | stdio versus HTTP or SSE; local versus remote | `src/capabilities/`, with the one remote filter |
| 17 | **Health** | Connection state and runtime health for the UI | per transport | the transport's `health` group |
| 18 | **Protocol recovery** | Resuming a lost thread, restoring a lost ACP session, rebuilding history | per protocol | each transport's own `restore/` |
| 19 | **Turn admission, recovery operations, Stop** | Is a turn running; cancelling it; the recovery operations Stop, the daemon and the MCP tools read | — | the runtime host, moved unchanged |
| 20 | **Transcript frames** | Writing the frames both apps read, live, stored and on replay | — | the projection, moved unchanged |

Rows 1–18 are the harness layer this plan rebuilds. Rows 19 and 20 are runtime concerns that other systems read; they move unchanged ([Scope](#scope)).

## What's wrong today

**1. Every responsibility is spread across both adapter stacks.**
- Two adapter cores, the SDK one and ACP's three-level class chain, each implement all 20 rows their own way.
- The contract that ties them together has **96 members:** 20 core, 26 across 17 add-ons, 7 goal actions, 14 host callbacks, 10 turn inputs and 19 driver members.
- **197 of the 409 commits** on these four packages since the fork are fixes.

**2. Defects live where two pieces meet, and they exist today.** The reviews found 24, all listed in the [defect register](#defect-register). Three examples, next to 42.8k lines of unit tests that exercise each piece separately:
- **Claxedo's own MCP server, with a bearer that acts as the workspace owner for 24 hours, is sent to remote ACP agents** (`acp/process-manager.ts:343-348`).
- **ACP answers the agent before the reply is saved** (`acp/index.ts:609-610`).
- **Brokered Codex sessions very likely start without plugins,** because their home is rebuilt with only the broker config (`codex/broker.ts:47-52`). This is inferred from the code.

**3. Adding a harness is expensive.** Today it means:
- implementing the 20 core members and the add-ons it supports, a driver, a translator, and a plugin projection adapter in a different package;
- adding the harness to four separate lists.

After the rebuild it's a transport (driver plus translator), a profile, and one registry row.

**4. The product can't do what it's meant to:**
- Pi can't be extended, because Claxedo pins its version, replaces its profile and injects its own extension.
- The OpenCode server fails any turn where OpenCode asks permission.
- Custom harnesses get no plugins.
- **Cloud harnesses are designed but broken:** hosted never delivers settings or provider credentials, OpenCode and custom harnesses fail in sandboxes, and no cloud turn is on record ([Cloud harnesses](#cloud-harnesses-how-a-person-configures-one)).

**5. Agents can't reason about it.** A code agent changing permission handling has to find all three request paths. Changing credentials means five transports and four harness lists. That's where the fix commits come from.

## Does it need solving?

**Some of it would be needed no matter what:** the defects in the [defect register](#defect-register) (36 rows at the P0.7 measurement), and deleting the ~6.9k lines of generated and unimplemented code. None of these depend on the rebuild.

**All of them are fixed inside it anyway, as part of v2, not landed separately first:**
- each fix goes where its code is being rebuilt, so nothing is fixed twice;
- each defect first gets a test that fails on `dev` today.

**The rest is worth doing only if Claxedo keeps adding harnesses and harness features.**
- If Claxedo only ever ran Claude and Codex locally, the fixes above plus the deletions would be enough, and a rebuild would be cost without return.
- The owner's direction says otherwise: any ACP agent, the person's own Pi, OpenCode, cloud and remote harnesses, plugins everywhere. Every one of those multiplies the cost of each responsibility being spread across two stacks and four lists.

**So yes: the rebuild is justified by the direction of the product, not by the line count.** The line count is a side effect.

## What this plan fixes and simplifies

**Every defect found is fixed here, as part of v2.**
- The [defect register](#defect-register) lists 24: 8 in the harness layer, 14 in cloud delivery, 2 in tests and docs.
- Each gets a regression test that reproduces it **red on `dev` first**, and goes green with the fix.
- The UI pieces (a cloud-consent toggle, the onboarding fix, the remote notice) are built in the app plan's v2.

**Leaner and cleaner, by giving each concept one owner:**

| Today | After |
| --- | --- |
| Four harness lists | One registry |
| Two pending-request tables with different rules | One broker |
| A 96-member contract across two adapter cores | One contract, every operation mapped to one owner |
| Four plugin projection adapters, in another package | One profile per harness |
| Settings in a local Node file, credentials in SQLite or D1 with different shapes | One repository for credentials and settings: D1 on hosted, SQLite locally |
| A cloud delivery path only the self-hosted server runs | One delivery path, run by hosted and self-hosted alike |
| 14 module-level mutable sites | Three named owners |
| Dead or half-wired code: a half-renamed startup key, an unconnected secret resolver, a static provider stub, unimplemented add-ons, 6.7k lines of committed generated code | Deleted or connected |
| 42.8k lines of unit tests, mostly against fakes | Real-stack flows, two corpora, focused invariant tests, and a regression test per defect |

## What could be better than this plan

| Option | What it gives | Why it isn't the plan | When it becomes right |
| --- | --- | --- | --- |
| **Do nothing** | No risk now | Every harness and feature pays the spread cost, and seam defects keep shipping | Never, given the direction |
| **Delete and fix only** | ~6.9k lines gone, three defects fixed, low risk | Leaves the two stacks, 96 members and four lists | Always: it's P0 of this plan anyway |
| **ACP for everything** (drop native transports) | About 5k fewer lines; one transport | Loses Codex goals, steering, quota windows and login; Claude SDK plugins, per-owner usage and per-turn effort; Cursor's SDK (ruled) | When ACP standardizes those. The plan's "why a native transport exists" rule deletes native code as that happens |
| **An external layer** (as Executor is for integrations) | Someone else maintains it | No such layer exists for harnesses. Executor covers integrations only, and even there isn't a fit to host | For integrations, as bring-your-own |
| **A journal-first runtime now** (D3: one journal, a turn row, write-once projection) | The simplest long-term shape; recovery and projection collapse | It changes what both apps, the MCP tools and the daemon read; the app rebuild promised today's contracts | With the server-contract rebuild, when only the app's adapter changes (decision 15) |
| **Generated translators** (table-driven from vendor schemas) | Smaller, provably complete translators | Needs the corpus first, to prove equivalence | P6, starting with Codex, whose types are already generated |
| **Machine-readable harness profiles from vendors** | Profiles become data, not code | Vendors don't publish them | Whenever they do; profiles are already data-shaped |

The plan is shaped so each better option can land later without rework:
- native transports shrink as ACP grows;
- the corpus proves generated translators;
- the moved runtime code is exactly what D3 replaces.

## Core beliefs

These drive every choice in Part 2. Where a choice seems arbitrary, one of these is the reason.

1. **Claxedo layers over harnesses and never owns their internals.** The harness owns its loop, tools, memory and compaction. We translate what it tells us and never re-implement what it does.
2. **A harness is what it declares and what its docs say, not what it's called.** Capabilities come from its handshake; projection comes from its docs. A name never grants anything.
3. **How we connect is separate from what the harness is.** A transport is a protocol; a profile is a harness. Claude over its SDK and Claude over ACP are one harness reached two ways.
4. **Every concept has exactly one owner.** Two implementations of one concept are a defect even when both work, because they drift. The three request paths are that defect.
5. **The wire is a contract.** Both apps, the MCP tools and the daemon read frames and recovery operations. Anything they read changes only on purpose, in a listed and approved change.
6. **Move before you rebuild, and rebuild only what you can prove.** Code where fixes accumulated moves unchanged first. It's rewritten only in a slice that the recorded samples prove equivalent.
7. **A secret goes only where it's needed.** Provider keys stay behind the broker, as placeholders in the sandbox. Nothing owner-acting leaves the machine. What a remote harness receives is decided in one filter.
8. **A claim is a hypothesis until the code or a run confirms it.** This plan's own history shows why: the review rounds overturned confident claims about dead code, unused routes and deletable engines. Every number has a command, and every "done" is a claim until tests agree.
9. **Tests exercise both sides of a seam with real peers.** Defects live between components, so tests do too.
10. **Every rule a machine can check is checked.** Conventions nobody enforces decay; ratchets and checks don't.

## Software principles applied

| Principle | Where it shows | What it makes easier to reason about |
| --- | --- | --- |
| **Ports and adapters** | One contract (`HarnessTransport`, the brokers, the services); transports and profiles plug into it | A harness question is answered in one folder; the core never sees a vendor SDK |
| **Separate what varies separately** | Transport (protocol) apart from profile (harness format) | One profile serves every way of reaching a harness |
| **Functional core, imperative shell** | Translators are pure: state and event in, events out. Drivers do the I/O | Translation is tested with data, deterministically, in seconds |
| **Capability negotiation, not identity checks** | ACP extensions and capabilities come from `initialize`; bug workarounds sit in one table keyed by the reported version | No `if (agent === "gemini")` scattered around |
| **One-way flow** | Transports yield events; requests go to the broker; the runtime writes frames | Nobody writes the store from inside a transport |
| **Dependency direction, and leaf packages** | `process-ownership` depends on nothing of ours; the core imports no transport; transports import only the contract | No cycles; the desktop keeps its small, reviewed dependency set |
| **Explicit state machines; illegal states unrepresentable** | Requests, processes, goals, subagents, projection and config changes are unions with one pure `transition` | Every state and move is listed; there are no parallel booleans |
| **Typed errors, no swallowing** | Each transport's `errors.ts`; no `.catch(() =>` | Every failure has a class and is shown or logged |
| **No ambient state** | 14 module-level mutable sites become instance fields or three named owners | Two workspaces in one process can't interfere |
| **Small, named units** | Files under 300 lines, functions under 40, no `utils` | An agent can read a whole unit |
| **Prove each part, then cut over once** | Every transport passes the conformance suite against its real harness program before P3; P3 points the runtime at all of them and deletes the old adapters in the same slice | There's never a second path left behind, and no temporary adapter to remove |
| **Characterization before change** | The translator corpus and wire corpus are recorded on `dev` before anything moves | "Unchanged" is a comparison, not a hope |
| **Ratchets** | Per-part line budgets and architecture ceilings that only go down | Regressions fail the build, not a review |

## Where a harness runs

| | This machine | A cloud sandbox | Someone else's machine (remote) |
| --- | --- | --- | --- |
| Who starts it | Claxedo, from the person's own install | Claxedo, from the sandbox image or an install spec | Its operator; Claxedo connects to it |
| The harness's own setup | the person's own config and login (Pi: their own profile) | a profile bundle the person uploads (never their `auth.json`) | its own |
| Provider credentials | the person's own login, or the broker's placeholders | the broker's placeholders; the real key is attached by the sandbox provider's network layer, and never enters the sandbox | its own accounts |
| Skills and plugins | through its profile | through its profile | not sent |
| MCP servers | all kinds | all kinds, inside the sandbox | only HTTP or SSE servers it declares; never Claxedo's own; never stdio |
| Stop | proven by process ownership | proven inside the sandbox | protocol cancel only; never proven |

**What exists today for the cloud** (read from the code):
- **The sandbox image preinstalls** Claude Code 2.1.150, Codex 0.133.0, Gemini CLI 0.43.0, Pi 0.85.1, `cursor-agent`, Amp and Factory's `droid`. There's no OpenCode CLI.
- **A runtime takes its settings as one snapshot** (`POST /api/wr/config`, version 4): MCP servers, custom harnesses, the default harness, credential placeholders, plugin folders, commands.
- **Only the Cloudflare, Daytona and Vercel drivers can broker secrets** so the real key stays outside the sandbox. The others refuse a turn that needs one.
- **The delivery path exists** (brokered secrets, settings snapshot, updates on change), but only the self-hosted server runs it, and hosted never does ([Cloud harnesses](#cloud-harnesses-how-a-person-configures-one)).

## Security posture

The harness layer holds the most valuable things Claxedo handles: people's provider accounts, Claxedo's own owner-acting credentials, and the decisions only a person may make. This section says what it protects, whom it trusts, the rules it enforces, the gaps that exist today, the risks you've accepted, and how each rule is tested.

### What it protects

| Asset | Why it matters |
| --- | --- |
| **Provider AI credentials** (API keys, subscription tokens) | A person's money and account |
| **Claxedo's own authority:** the owner grant, runtime access tokens, the relay and session tokens, and **the first-party MCP bearer, which acts as the workspace owner for 24 hours** | Anyone holding one acts as the owner |
| **Integration tokens** behind the MCP gateway, and gateway passes | A person's GitHub, Linear and similar accounts |
| **Custom-harness secrets** | Keys and headers a custom or remote agent needs |
| **The machine**: its files, its processes, the other secrets on it | A harness runs as the owner's user |
| **Decisions only a person may make**: permissions, questions, elicitations | Agreeing to something is the person's call, not the agent's |
| **Other people's sessions and accounts** | Members and shares must never spend someone else's account |

### Whom it trusts

| Actor | Trusted with | The boundary |
| --- | --- | --- |
| **The machine owner and their processes** | Everything on their machine | **Accepted posture** (your ruling, 2026-09-23): a harness turn runs as the owner and can read the machine's secrets. Unsigned mode is loopback-only (M-1) |
| **A harness Claxedo starts on this machine** | What the owner's user account can do | The same trust as the owner. Claxedo layers over it and doesn't pretend to sandbox it |
| **A harness in a cloud sandbox** | The sandbox, and placeholders for provider keys | The sandbox. The provider's network layer attaches real keys only on requests to provider hosts (H-1) |
| **A remote harness** (someone else's machine) | Only what its API receives | **Untrusted:** never Claxedo's own MCP server or bearer, never stdio servers, never brokered credentials. Plugin tokens only with endpoint-bound consent (integration plan) |
| **A member acting through a share** | Exactly what the share allows (a `send` share can prompt) | The route's access policy decides who. The turn spends the session owner's accounts, like every turn in that session |
| **Harness output**: model text, tool results, events, elicitation forms | Nothing | Untrusted input. Translators check shapes (ACP `validation.ts`); unknown events become typed `unrecognized` events; form patterns are checked in a bounded worker pool; Claxedo never runs harness output as its own instructions |
| **What an agent says about itself** (name, version) | Nothing | Descriptive only. It can pick a profile's format and never grants plugin authority |

### Rules the harness layer enforces

1. **A secret goes only where it's needed.**
   - Provider keys are brokered: a placeholder in the environment or config, and the real value attached outside the harness.
   - Custom-harness secrets are leased per launch, and expire and can be revoked.
   - A remote process's environment is never set. Today's `acp/connection-provider.ts:97` already refuses environment bindings for remote agents.
2. **Nothing owner-acting leaves the machine.** Claxedo's own MCP server and its bearer go only to harnesses Claxedo starts. One remote filter covers `session/new`, load, resume and fork.
3. **A person's decision is answered only three ways:** by an authorized person, by a written policy (a permission mode within its ceiling), or by cancel.
   - Replies are saved before the harness is released.
   - Grants are scoped to the session and to the harness connection that asked; a grant never answers another harness.
   - "Once" never widens to "always".
   - Cancel never allows.
4. **Credentials follow the session's owner, not the turn's sender** (owner ruling, 2026-09-25). Every turn in a session spends the owner's accounts, including a turn a member sends through a `send` share.
   - The owner's own machine logins (their Pi login, for example) serve the owner's sessions on the desktop or loopback runtime; everywhere else the owner's chosen accounts are brokered.
   - The sender decides who may send and is recorded for audit; it never selects credentials.
5. **A person's own setup is never modified.**
   - The owner's Pi folder is never written.
   - Claude and Codex homes are composed in folders Claxedo owns, never the person's own.
6. **Processes are owned, and their stop is proven.**
   - The launch gate uses a nonce.
   - A process's creation identity is checked before it's signalled.
   - Retirement proves the whole process tree stopped.
   - A remote stop is never reported as proven.
7. **Untrusted input has bounded cost:** a validation pool of two workers with 32 MB each, deadlines on every request, typed errors, no silent fallbacks.
8. **Claxedo doesn't sandbox local harnesses.** Isolating a harness on this machine is the harness's and the operating system's job. The plan doesn't claim otherwise.

### Gaps today

| Gap | Where | Fixed by |
| --- | --- | --- |
| **The first-party MCP bearer (owner-acting, 24 hours) is sent to remote ACP agents** | `acp/process-manager.ts:343-348` | H-1: the remote filter in P2 |
| **Stdio MCP servers are sent to remote ACP agents** | `mcp-resolver.ts:284-290` through `process-manager.ts:344` | H-2: the remote filter |
| **ACP releases a permission before saving the reply** | `acp/index.ts:609-610` | H-3 |
| **No identity of the actor reaches a transport** | `AgentExecutionBinding`, `PromptInput` | `StartInput.owner` for credentials and `TurnInput.origin` for authorization and audit (C-12) |
| **Reusing today's Pi code on the owner's folder would wipe their login** | `pi/auth.ts:119-121`, `:160` | The owner transport never writes the folder |
| **Brokered Codex very likely starts without plugins.** An availability gap, not a leak | `codex/broker.ts:47-52` | H-4 |
| **Three harnesses in the cloud image are installed by unpinned `curl \| bash` installers** (`cursor-agent`, Amp, `droid`). A supply-chain risk | `scripts/sandbox/Dockerfile`, `cloudflare-worker/Dockerfile` | C-13 |
| **Accounts are picked per org everywhere, never per person,** against the per-person account ruling: the owner column is never written, activation carries no actor, and the broker's identity is a fixed `"operator"` | `registry.ts:185`, `native-delivery.ts:188` | C-12 |
| **Hosted cloud delivers no provider credential.** An availability gap: turns very likely can't authenticate | `supervisor/sandbox.ts:108` is the only caller | C-1 |

### Risks you've accepted

- **A local agent turn can read every secret on the machine:** passed-through environment, the data folder, and the credential seed beside its ciphertext. Accepted 2026-09-23, because processes on the owner's machine are trusted.

  **Keep one consequence in view:** a member with a `send` share on the owner's desktop drives an agent with that reach. That's decided per share, separately from this plan.
- **Unsigned mode is a loopback-only developer setup** (M-1). Local processes are trusted.
- **A localhost cookie can be seen by other local ports** (P-108), accepted on localhost.
- **Secrets that must be inside the harness's environment are visible there:** leased custom-harness secrets, and secrets for local MCP commands. The settings screen says so.
- **Sandbox drivers that can't broker keys refuse** turns that need a provider key (decision 20).
- **By design, but not yet ruled on:** "machine provider config" sends the owner's **raw key** to an enrolled machine, sealed in transit, and that machine's harness then holds it (`machine-provider-config.tsx:73-78`, `host-provider-config.ts:78-83`). It fits trusting the owner's own machine. It shouldn't extend to a machine the owner doesn't control.

### How each rule is tested

| Rule | Proven by |
| --- | --- |
| 1, 2: secrets and remote | H24: `session/new`, load, resume and fork to a remote agent carry no first-party server, no bearer for it, no stdio servers. H19: brokered keys in the sandbox |
| 3: decisions | H3: allow, deny, and refused stale, duplicate and foreign replies. H3b: save before release under a failed write. H4: elicitation, URL consent, cancelled validation. H10: a refused widening of a child's permission mode. Focused tests: grant keys, save before approval |
| 4, 5: identity and setup | H20: owner, `send` share, queued re-issue, expired, missing, concurrent owner and member. H18 and H20: the owner's `auth.json` byte-identical afterwards |
| 6: processes | H9, H23 (Windows), and the focused descendant-retirement test |
| 7: bounded input | Focused validation-race tests; the no-swallowed-errors check |
| All | Each flow's targeted red run, at the boundary the rule protects |

**Owned elsewhere:** relay and control-plane authentication, integration OAuth, the sandbox provider's own isolation, and signed installers.

## Why fewer, real-stack tests prove more

**Today:** 42.8k lines of unit tests, about 1,470 cases, in the four packages. Most test one side of a seam against a fake of the other side: in-memory and SQLite stand-ins for the runtime store, mocked hosts, stand-in drivers. A fake agrees with whatever its author expected, so these tests pass when each side agrees with its fake, not when the two sides agree with each other.

**The evidence that this misses the defects that matter:**
- **The three live defects above sit exactly on seams:**
  - how an ACP process is set up versus what kind of connection it has;
  - the reply route versus ACP's release order;
  - the brokered Codex home versus plugin projection.

  Each side has its tests. The seam has none.
- **This project's defect notes record the same pattern more than once:**
  - "one-sided seams" (one side wired and tested, the other not) are recorded as the dominant defect class;
  - a permissive fake accepted any message id, so every wake turn failed live while every test was green;
  - an e2e test asserted the one route, of two answering the same question, that happened to filter correctly;
  - a lenient `JSON.parse` quietly turned a negative test into a no-op;
  - 32 of the old app's 58 e2e specs ran against a hand-written fake of 70 server routes (sibling plan).

**The replacement is layered by what each layer can prove:**

| Layer | What it proves | Speed | What could fool it, and the guard |
| --- | --- | --- | --- |
| **Translator corpus** | Each translator maps recorded provider input to exactly the same events, including multi-step turns | Seconds, no processes | A recording that misses a case. Guard: P0.5 maps every fix commit and every test case to a corpus case, a flow, or a written reason |
| **Wire corpus** | What the apps, MCP tools and daemon receive is unchanged: live frames, stored history, replay, control replies, recovery operations, the same ids across channels | One run per scripted flow | Normalization hiding a real difference. Guard: ids are mapped consistently (which frames share an id is kept); `state` and `phase` are never normalized |
| **Real-stack flows** | Both sides of every seam work, with real harness programs. Only what Claxedo doesn't own is scripted: the model endpoint, a scripted ACP agent, the OAuth provider, the sandbox provider | Up to 60 s each, sharded | A flow passing for the wrong reason. Guard: each has a targeted red run and asserts one fact read back from the server |
| **Focused invariant tests** | Races and timing a flow can't hit deterministically: admission order, stale steering, save-before-release under a failed write, validation races, descendant retirement | Milliseconds | They run the real implementation, not a fake |
| **Checks and ratchets** | Structure: boundaries, no ambient state, no swallowed errors, budgets | Seconds | — |

**Why that's stronger:**
1. **It covers the seams.** A flow runs route → broker → transport → real harness → translator → projection → wire. A defect anywhere in that chain fails it. A unit test covers one hop.
2. **Fakes only at the true edge.** Everything Claxedo owns is real in every flow. Only the model, the ACP agent, OAuth and the sandbox provider are scripted.
3. **Every test is proven able to fail at the boundary it claims.** Each red run injects a fault there: a refused write, a killed process, a dropped frame. A test that can't go red proves nothing.
4. **Nothing silently loses coverage.** Every deleted test case maps, in P0.5, to a flow, a corpus case, a kept invariant test or a written reason, and the map is reviewed.
5. **The tests define "no behavior change".** The corpora and baseline flows are recorded on `dev` before anything moves, and must hold on the branch unchanged. Because they don't encode internals, the rebuild doesn't have to rewrite them.
6. **The negative cases are first-class,** each a flow with its red run:
   - stale, duplicate and foreign replies;
   - a leak through the remote filter;
   - a member's turn in an owner's Pi session, which spends the owner's profile;
   - an expired credential.
7. **Every defect is a test first.** Each defect in the register gets a regression test that fails on `dev` today, at the boundary where the defect lives, before it's fixed. That proves the new tests catch exactly the kind of defect the old ones let through.

**The honest costs:**
- **A flow is slower than a unit test.** The corpora carry the fast feedback; flows are sharded on crabbox; a new flow qualifies with 20 runs once.
- **Infrastructure has to be built first:** a websocket ACP agent, a sandbox driver, a Windows lane, a Cursor backend (P0.1).
- **Some invariants can't be reached deterministically by a flow.** They stay as focused tests, named in the invariant map.
- **Real harness programs change.** They're pinned, in the image and in the e2e harness, and drift shows up as a corpus difference. That's the point.

## Cloud harnesses: how a person configures one

**The design already exists.** Everything a cloud harness needs is in the code today:
- settings a person can edit;
- credentials that stay outside the sandbox;
- one snapshot of settings sent to each sandbox;
- updates pushed out when settings change;
- plugins;
- a sandbox-side secret resolver.

**What's wrong is that it's broken or unwired in specific places,** and the hosted product never runs the delivery half. This section describes the system as built, where each piece works, and the defects. It was traced on 2026-09-25 by three read-only reviews (desktop and daemon, credentials, hosted settings), and every claim below was checked against the code.

### How it's designed

1. **The person configures:**
   - **harnesses:** built-in ones, plus custom connections such as an ACP agent by command or URL, with secrets stored as references;
   - **their MCP servers;**
   - **a default harness;**
   - **commands.**

   These are kept in `~/.claxedo/user-agent-config.json` (`agent-config/index.ts:79-105`). Provider accounts go in the credential registry, each marked `local` or `shared`, and `shared` needs consent to be used in the cloud (`registry.ts:965-999`). Plugins go through Agent Plugins.
2. **A supervisor creates the sandbox** through a driver: Daytona, Cloudflare, Modal, Vercel, Box or Docker (`supervisor/sandbox.ts:565-690`).
3. **Provider credentials go out as brokered secrets** (`resolveSandboxBindings` → `sandboxBrokeredSecrets` → `nativeProviderDeliveries`, `sandbox.ts:104-121`).
   - The driver registers the real key with the sandbox provider's network layer. On Cloudflare that's the worker's `EGRESS_SECRETS` store.
   - The harness sees only a placeholder: `NAME=claxedo-broker:NAME`.
   - The real key is substituted on requests to that provider's hosts (`outbound-credentials.ts:110-160`).
4. **Settings go out as one snapshot:** `pushRuntimeConfig` sends version 4 (MCP servers, connections, default harness, credential placeholders, plugin folders, commands) to `/api/wr/config`, signed by the supervisor (`config-sync.ts:14-51`). The runtime applies it and resolves each placeholder inside the sandbox (`routes/config.ts:172-188`).
5. **Changes reach running sandboxes:**
   - settings changes fan out (`fanout.ts:14-25` → `broadcastRuntimeConfig`);
   - credential changes reconcile (`reconcileCredentialDelivery`).
6. **Plugins arrive through `/api/wr/agent-plugins/apply`,** with plugin MCP servers going through the gateway on a pass the provider attaches on the way out.
7. **Inside the sandbox:**
   - Claxedo's own MCP server runs on loopback;
   - custom-connection secrets are meant to be leased by `createVmConnectionSecretResolver`.

### Where it works today

| Capability | Self-hosted server, as the operator's supervisor | Hosted (Cloudflare Worker + D1) | Desktop daemon |
| --- | --- | --- | --- |
| Create a cloud workspace | Works, with six drivers | Works | **Not provided by design** (`start-local-server.ts:9-16`), yet onboarding offers "A cloud sandbox", which fails with a 404 when unsigned |
| Choose the harness | Works: default or per session | Works for Claude, Codex, Cursor, Pi. **OpenCode fails**; custom ACP fails | — |
| Settings snapshot sent | **Fails by default:** the signing key pair is required and missing | **Never sent** | — |
| Provider credentials | Works on Daytona, Vercel and Cloudflare, **for accounts marked `shared`, which no screen can set** | **Never delivered.** Keys are stored in D1 and never leave | — |
| The person's own MCP servers | **Dropped** for cloud sandboxes | **Never sent** | — |
| Plugin MCP servers | **Missing** on self-hosted | Works through the gateway | — |
| Claxedo's own MCP server | Works | Works | — |
| Custom-connection secrets | **Resolver not connected** | **Resolver not connected** | — |
| Proven live | The image smoke test ran a Pi turn with a snapshot it sent itself | **No recorded cloud turn.** Deployed egress acceptance is "pending" (`cloudflare-worker/README.md:146-153`) | — |

### The defects

**Hosted, the product's main cloud path:**
1. **The delivery half never runs.** Only the self-hosted server composes the supervisor, so hosted cloud sandboxes get no settings snapshot and no provider credentials.
   - The org's keys are stored in D1 (`credentials/worker/pi.ts`) and shown as connected, but they never leave D1.
   - The sandbox worker's credential handler is complete and receives only the clone token and plugin passes.
   - **So a hosted cloud model turn very likely has no key.** That's inferred; no live turn is recorded.
2. **Hosted has no store for harness settings.** Connections, MCP servers and the default harness live only in a Node file. D1 has provider credentials and `claxedo_custom_provider`, but the custom-provider routes exist only on the local server. Hosted's provider screen is a static stub (`routes/hosted/shell.ts:170-175`) listing Pi only.
3. **OpenCode fails in a hosted sandbox.** Its runtime is only created when the startup environment names it (`runtime-boot.ts:141-143`; `workspace/runtime.ts:564-568`), and nothing can name it (defect 9). The composer still offers it.
4. **Custom ACP harnesses fail in any sandbox.** The runtime accepts only connections from an applied snapshot (`workspace/runtime.ts:927-931`), and hosted sends none. A signed desktop can pick one of its local connections for a cloud draft, which returns 409.

**Self-hosted:**

5. **Sending the settings snapshot fails by default.** It needs `CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM`; without it, token minting fails (`runtime-access-token.ts:161-167`). The fallback key-verification URL is plain-HTTP loopback, which the runtime refuses (`management-auth.ts:83-88`) and the server doesn't serve. So every sandbox start ends with "config push failed" until the operator sets a key pair.
6. **No screen can mark a credential `shared`,** so cloud sandboxes receive no provider credentials in practice. The endpoint exists (`PATCH /credentials/:id/scope`); `provider-connect-form.tsx` has the prop, and nothing sets it.
7. **Changing the default harness doesn't reach running sandboxes** (`harness-routes.ts:42-58` doesn't fan out). Commands are never put in the snapshot. Plugins never arrive on self-hosted.

**Everywhere:**

8. **The person's own MCP servers are always dropped for cloud sandboxes** (`agent-config/index.ts:588`), including HTTP servers that would work there.
9. **A startup key was half-renamed.** Drivers write `WORKSPACE_RUNTIME_RUNNER` (`sandbox-manager/src/runtime-env.ts:51`), but the runtime now reads `WORKSPACE_RUNTIME_NATIVE_HARNESS` and `WORKSPACE_RUNTIME_CONNECTION_ID`. An old build still reads the old name. So no deployment can set a default harness, and the e2e spec that sets the old key (`real-session-directory-isolation.spec.ts:96`) likely tests nothing.
10. **Custom-connection secrets can't reach a sandbox.** `createVmConnectionSecretResolver` has no callers, and the runtime refuses any secret reference (`workspace/runtime.ts:920-925`).
11. **OpenCode never receives provider credentials in any sandbox.** Its engine is created with no provider binding (`opencode-runtime.ts:15`).
12. **Account selection is per org everywhere, never per person.**
    - The registry's owner column is never written (`registry.ts:185`).
    - Activation carries no actor.
    - The broker's identity is a fixed `"operator"`.
    - This goes against your per-person account ruling.
13. **Sandboxes with Docker, Modal or Box never receive credentials** (by design they can't broker). Docker is the realistic driver for a self-hosted operator.
14. **Three agent programs in the image come from unpinned `curl | bash` installers:** `cursor-agent`, Amp and `droid`.
15. **The desktop onboarding offers a cloud sandbox the daemon can't create,** and saves a driver key for it that nothing uses.

### What to do: connect it, don't redesign it

**The fix is part of this plan (P2 cloud)**, and it's mostly wiring existing parts together, in this order. The defect IDs are in the [defect register](#defect-register).

| # | Change | Reuses |
| --- | --- | --- |
| 1 | **Hosted delivery:** a hosted supervisor that computes brokered secrets from D1, per person, sends the version 4 snapshot, fans out changes, and reconciles credentials | `sandboxBrokeredSecrets`, `nativeProviderDeliveries`, `pushRuntimeConfig`, `reconcileCredentialDelivery`, the worker's credential handler. The one real refactor: the credential registry and settings storage behind one repository, with D1 on hosted and SQLite locally (D8) |
| 2 | **A hosted settings store** (D1) for connections, MCP servers and the default harness, using the same shape as `user-agent-config.json` | The agent-config validators and routes |
| 3 | **One name for the startup harness key**, written and read the same way | — |
| 4 | **Self-hosted signing keys created at first start,** with a pinned verification key instead of plain-HTTP key discovery | `WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM` |
| 5 | **A per-account "allow in the cloud" consent** in Settings | `PATCH /credentials/:id/scope` |
| 6 | **Per-person account selection:** write the owner, carry the actor | the owner column in the schema |
| 7 | **The person's MCP servers filtered, not dropped:** HTTP servers with brokered tokens pass; local commands pass only if the image or an install spec provides them | the remote filter from Part 2 |
| 8 | **Connect the sandbox secret resolver** | `createVmConnectionSecretResolver` |
| 9 | **OpenCode provider binding in sandboxes** | `bindProviders`, through the OpenCode transport |
| 10 | **Fan out default-harness changes, send commands, deliver plugins on self-hosted** | `fanOutConfig`, the apply route |
| 11 | **Hide the cloud option in unsigned desktop onboarding** | — |
| 12 | **Pin every agent program in the image** by version and checksum | — |
| 13 | **A live cloud turn on staging, for each harness** (flow H19), as the acceptance test | the deployed acceptance harness |

**Genuinely new pieces**, the only new design:
- **install specs,** to run a harness that isn't in the image, for example a person's own ACP agent;
- **profile bundles,** so a person's Pi extensions or `opencode.json` can follow them into the cloud (never login files).

# Part 2: The plan

## Scope

**This plan rebuilds the harness layer:** one contract, one broker, a registry, transports (how Claxedo drives a harness) and profiles (how skills, MCP servers and plugins get into a harness, from its docs).

**It also fixes the cloud delivery path and every defect found, as part of v2** ([Defect register](#defect-register)).
- Cloud delivery is mostly connecting code that exists: brokered secrets, the settings snapshot, fan-out and credential reconciliation, run by hosted as well as self-hosted ([Cloud harnesses](#cloud-harnesses-how-a-person-configures-one)).
- Nothing lands on `dev` separately first.
- UI pieces go into the app plan's v2.

**Moved unchanged**, because the reviews showed each is load-bearing well beyond the harness:

| Moves unchanged | To | Why |
| --- | --- | --- |
| Translators | their transport folders | provider fixes live there |
| The runtime host, including the recovery engine, turn admission, the goal controller, titles and handoff | `workspace-runtime` | today's Stop in both apps, v2's `session-stop.ts`, the local daemon's lifecycle, the desktop's daemon recovery and the MCP tools all read the recovery operations it produces |
| The projection code, all three sites | `workspace-runtime` | the frames both apps read, including today's differences between live and stored frames, must stay exactly as they are |
| Launch and process ownership | a new dependency-free package, `packages/process-ownership` | the desktop and the CLI use it without the runtime |

**Not in this plan.** These go with the server-contract rebuild, when the app's adapter changes anyway (D3):
- the turn row that replaces the recovery engine;
- one projection that writes each frame once;
- simpler recovery routes.

Decision 15 confirms that timing.

## How the work runs

1. **A dedicated worktree:** `~/test/opencode-harness` on `feat/harness-v2`.
2. **Process ownership moves first, into its own package.** P0.1 moves `launch/*`, `process-lifecycle.ts`, `process-observer.ts`, `windows-process.ts` and `spawn-env.ts` (2,222 lines) into `packages/process-ownership`.
   - It imports only `@claxedo/helpers` and `@claxedo/agent-runtime-contract`.
   - `agent-sdk-runtime`, `workspace-runtime`, the desktop, the CLI and the local server import it directly. So no package cycle appears, and the desktop's reviewed allowance ("dependency-free data and OS reads") still holds.
   - `acp/process-retirement.ts` stays with ACP.
3. **A new package, `packages/harness`** (`"private": true`), with three kinds of folders separated by a check:

   | Folder | Holds |
   | --- | --- |
   | `src/contract/` | the core: the contract |
   | `src/broker/` | the core: the broker |
   | `src/registry/` | the core: the registry |
   | `src/capabilities/` | the core: capabilities |
   | `src/translate/` | the core: the translator runner and shared translator helpers, moved unchanged |
   | `src/transports/<kind>/` | one transport each: `claude-sdk`, `codex-app-server`, `cursor-sdk`, `acp`, `pi-rpc` and `opencode-sdk` (decision 2) |
   | `src/profiles/<harness>/` | one profile per harness |

4. **Each transport is proven on its own, then the runtime cuts over once** (decision 14).
   - A transport lane builds its transport and passes the conformance suite (`packages/harness/src/conformance/`): the suite drives the transport through the contract, with the real broker over in-memory runtime ports, against the real harness program answering from the scripted model server or the scripted ACP agent.
   - P3 points the runtime host at every transport in one slice and deletes every old adapter in the same slice. The flows gate that slice.
5. **Today's server contracts stay.** That covers every route, event, payload, frame and recovery operation either app, the MCP tools or the daemon reads. It's proven by the wire corpus.
6. **You review, then one merge.**

**Outside `packages/harness`, these change:**
- **`packages/process-ownership` (new):** the moved code, unchanged.
- **`workspace-runtime`:**
  - the runtime host (`runtime.ts` and `runtime/*`, 3,604 lines) and the projection code (3,181 lines), moved in unchanged;
  - the `spawn` service over `process-ownership`;
  - in P3, the runtime host calling the contract for every harness.
- **`agent-runtime-contract`:** keeps `recovery.ts` whole, because the daemon lifecycle, the desktop, the apps and the MCP tools use it. It gains the event contracts (`agent-event-runtime/src/contracts`, 458 lines) that the apps read.
- **Both apps: import paths only.** 13 production files in `claxedo-app` import `@claxedo/agent-event-runtime`, and v2 mirrors them under `src/legacy/` plus `session/view/timeline/message-author.tsx`. They move to `agent-runtime-contract` in one change before P4, coordinated with the app plan.
- **`claxedo-local-server`, `claxedo-server`, desktop, CLI:**
  - import paths;
  - the local server's four plugin projection adapters become profiles;
  - every launch-gate-child packaging site ([Process ownership](#3-process-ownership-its-own-package-first)).
- **The cloud delivery path:**
  - `claxedo-server-core` credentials and agent config;
  - the `claxedo-server` supervisor and hosted routes;
  - `sandbox-manager` drivers and the sandbox worker;
  - the sandbox images.

  It gets the register's fixes, and one repository for credentials and settings, with D1 and SQLite backends.
- **App v2** (in the app plan): the cloud-consent toggle, the onboarding fix and the remote notice.
- **Product-boundary policies:** ceilings re-measured on every import-changing slice ([Conventions and their checks](#conventions-and-their-checks)).
- **Nothing on npm.**

## Why today's server contracts

The app rebuild runs against today's server contracts. This plan keeps them.

**What stays exactly as it is:**
- the presentation events;
- the routes and payloads;
- stored history as the message routes return it;
- replay;
- the recovery routes and every operation field their parser requires (`state`, `phase`, `receipt`, `attempt`, `nextActions`, `cleanupErrors`, facts);
- the recovery receipts behind them (`recovery_operation`, unique on `scope_key`, `caller_id` and `request_id`, `store.ts:1398`);
- `needs_action` as the normal result of Stop when cleanup can't be proven;
- boot behavior: busy sessions marked `recovering`, and new turns refused with HTTP 503 `workspace_launch_unreconciled` while launches are unresolved.

**Why moving these unchanged is the safe choice:**
- Today's Stop turns silently into a no-op when an inspect body fails the operation parser (`submit-abort.ts:92-97`).
- v2 reports `operation.state` and `initiatingError` as the composer's Stop error (`src/server/session-stop.ts:15-26`).
- The local daemon's lifecycle drives machine-level recovery through the same engine (`local-daemon-lifecycle.ts:2-19`).

## Where the lines go

| Where the 49.7k production lines go | Lines | Needs the rebuild? |
| --- | --- | --- |
| Deleted: the generated Codex protocol, the harness factories, add-ons with no implementer | ~6.9k | No |
| Moved to test support: the in-memory, SQLite and persisted-row test stores | 1,860 | No |
| Moved unchanged: process ownership (2,222), the runtime host (3,604), projection (3,181) | ~9.0k | No |
| Rebuilt into `packages/harness` and trimmed: contract, broker, registry, transports, profiles, plus `agent-runtime-contract` | ~31.9k → ~19.2k at the merge (`packages/harness` 15.7k + `agent-runtime-contract` 3.5k), ~17.1k after P6 | Yes |

The publish ceremony and acceptance scripts live under `packages/*/scripts/`, outside `src/`. They're deleted, but they aren't part of the 49.7k.

What only the rebuild buys is in Part 1: [What's wrong today](#whats-wrong-today) and [The core responsibilities](#the-core-responsibilities).

## Defect register

The P0.2 expected-red defects below must turn green on the branch. The wire corpus also exposed H-19 through H-28 in passing flows; those recordings are excluded from the P3 gate until their producers are fixed and two comparisons match. A single observed diff is identified where a paired capture has not recurred.

| ID | Defect | Kind | Where | Fix | Phase | Regression test |
| --- | --- | --- | --- | --- | --- | --- |
| H-1 | Claxedo's own MCP server, with its 24-hour owner-acting bearer, is sent to remote ACP agents | Security | `acp/process-manager.ts:343-348` | One remote filter; `firstPartyMcp` local only | P2 ACP | H24 |
| H-2 | Stdio MCP servers are sent to remote ACP agents | Security | `mcp-resolver.ts:284-290` through `process-manager.ts:344` | The remote filter: only HTTP or SSE servers the agent declares | P2 ACP | H24 |
| H-3 | ACP releases a permission to the agent before saving the reply | Correctness | `acp/index.ts:609-610` | The broker saves, then releases | P1.2, P2 ACP | H3b |
| H-4 | Brokered Codex sessions very likely start without plugins | Availability | `codex/broker.ts:47-52`, `codex/driver.ts:561` | The transport composes `CODEX_HOME` from credentials and profile fragments | P2 Codex | H15, brokered case |
| H-5 | Pi drops extension-UI requests beyond five kinds | Correctness | `pi/driver.ts:551-559` | All nine kinds passed on | P1.3 | H18 |
| H-6 | Pi can't run the person's own setup (pinned version, Claxedo profile, injected extension) | Product | `pi/executable.ts`, `agent-dir.ts`, `title-extension.ts` | Pi as a custom harness for the owner's turns | P1.3 | H18, H20 |
| H-7 | The OpenCode server transport fails any turn where OpenCode asks permission | Availability | `opencode-server-adapter/src/adapter.ts:221` | The server adapter deleted: OpenCode runs only on its embedded engine, whose requests go through the broker (decision 2) | P2 OpenCode | H17 |
| H-8 | ACP's process-wide prompt counter makes a config restart wait on other workspaces' turns (inferred) | Correctness | `acp/turn-runner.ts:52`, `acp/index.ts:682` | Instance state | P2 ACP | H21 |
| H-9 | Archiving a session leaves its own running turn running: `PATCH /session/:id` cancels admitted turns only in child sessions (found by H12 on the ACP harness) | Correctness | `workspace-runtime/src/routes/session-core.ts` | Archive cancels and settles the session's own admitted turn | P3 | H12 |
| H-10 | Codex never receives the user's configured MCP servers: the driver keeps them in `currentMcp`, but `threadConfig` sends only the first-party server (found by H14) | Availability | `codex/driver.ts:151-169` | The Codex transport sends every projected server | P2 Codex | H14 |
| H-11 | A Pi dialog with a timeout never records an expired request: the driver ends the dialog on its own timer but asks as an ordinary question without the deadline (found by H4) | Correctness | `pi/driver.ts` `question()` | The dialog becomes a broker request with `expiresAt`, and the broker persists `expired` | P1.3 | H4.pi |
| H-12 | The app's `/compact` always fails on a harness that declares commands: it calls the summarize route, which no adapter ever implemented (409 before P0.3, 501 after) | Product | `claxedo-app/src/features/session/ui/use-session-commands.tsx` `session.compact` | `/compact` runs the harness's own compact command through `CommandOperations`, or isn't offered | P3 | — |
| H-13 | Native turns never store the assistant message's tokens: Claude's `result` usage, Codex's `thread/tokenUsage/updated` and Pi's `message_end` usage each become a `session.usage` event with the right message id, and session totals are right, but the stored assistant `info.tokens` stays zero (ACP stores them; found by H13) | Correctness | the runtime projection that folds `session.usage` into stored messages | Usage folds into the assistant message it names, for every harness | P3 | H13.claude, H13.codex, H13.pi |
| H-14 | A session id isn't owned across workspaces: creating an id that exists in workspace A from workspace B returns 201 and launches a second native session, because the create path resolves workspace-local state before any global ownership check (found by H37) | Correctness | the session create route and session registration in `workspace-runtime` | One owner per session id, checked before any harness launches; the conflict refused with a typed error | P3 | H37.scope |
| H-15 | Public session routes answer some refusals untyped: a message to an unknown session is a bare 500, and a create with no directory a bare 404 (found by H37) | Correctness | `workspace-runtime` session routes | Typed refusals before any harness is resolved | P3 | H37.typed |
| H-16 | A harness without todos answers the todo read as an empty list: Pi declares no todos, yet `GET /session/:id/todo` returns `200 []`, because a truthy empty replay returns before the capability check (found by H37) | Correctness | the todo route in `workspace-runtime/src/routes/session-core.ts` | The capability decides first: a typed `unsupported_operation`, which the app's todo reads treat as no todos | P3 | H37.todo |
| H-17 | Deleting a session whose harness switch is still pending leaves the kept source process running: deletion reaches only the target adapter, not the runtime's release of the kept source (found by H35) | Availability | session deletion in `workspace-runtime` (`releaseKeptHandoffSource` is never reached) | Deletion through the runtime's own session transaction, which retires a kept source | P3 | H35.delete |
| H-18 | Pi accepts a response whose `command` differs from the pending request, settling that request before Pi's real reply (found by H18) | Correctness | `agent-sdk-runtime/src/harnesses/pi/rpc-process.ts` `receive()` | The Pi RPC transport answers each request only from a reply matching its id and command. It ignores an unknown id (a late reply after a timeout) and a mismatched command, each as a diagnostic, and keeps waiting for the real reply until the request's own timeout | P3 | H18 |
| H-19 | H12 emits different `session.updated` sequences for one session, including an update without `info.slug`; [two recordings and diff](../../packages/harness/e2e/corpus/races/H12-title-archive.json) | Correctness | session update publication in `workspace-runtime` | Serialize updates for one session and preserve the canonical session info | P3 | H12-title-archive corpus, excluded until fixed |
| H-20 | H2 Stop emitted `session.idle` and `session.status` in opposite order for one session in one comparison; twelve later retries matched, so a paired capture is pending | Correctness | session stop lifecycle in `workspace-runtime` | Publish the terminal status and idle in one stable session order | P3 | H2-stop corpus, excluded until fixed |
| H-21 | H3 native permissions emitted `session.updated` and `session.status` in opposite order for one session in one comparison; a paired capture is pending | Correctness | native permission/session lifecycle in `workspace-runtime` | Establish one order for request and session updates | P3 | H3-native-permissions corpus, excluded until fixed |
| H-22 | H5 native child session status and idle changed order under the same child key; [two recordings and diff](../../packages/harness/e2e/corpus/races/H5-native-subagents.json) | Correctness | child session lifecycle in `workspace-runtime` | Serialize the child terminal status and idle | P3 | H5-native-subagents corpus, excluded until fixed |
| H-23 | H6 Goal turn omitted an aborted assistant `message.updated` on one run; a separate run showed optional Claude diagnostics, and a clean paired capture is pending | Correctness | Goal turn message publication in `workspace-runtime` and harness diagnostics | Publish a stable message sequence for a Goal turn; identify the diagnostic producer separately when reproduced | P3 | H6-goals corpus, excluded until fixed |
| H-24 | H8 restart emitted `pty.created` on one run but not another; [two recordings and diff](../../packages/harness/e2e/corpus/races/H8-restart-mid-turn.json) | Correctness | terminal creation across daemon recovery in `workspace-runtime` | Make terminal creation observable once across the restart boundary | P3 | H8-restart-mid-turn corpus, excluded until fixed |
| H-25 | Codex MCP startup emitted an optional `runtime.mcp_server_status` frame in H3, H11, or H35; [H3 pair](../../packages/harness/e2e/corpus/races/H3-native-permissions.json), [H35 pair](../../packages/harness/e2e/corpus/races/H35.native-handoff.json); H11's pair is pending | Correctness | Codex runtime diagnostic publication | Publish the MCP startup result deterministically for a session | P3 | H3-native-permissions, H11-attachments, H35.native-handoff corpora, excluded until fixed |
| H-26 | Claude SDK initialization emitted a different count of `claude_sdk.unmapped_event` frames under one session; [two recordings and diff](../../packages/harness/e2e/corpus/races/H7.unknown-held.json) | Correctness | Claude translator diagnostic publication in `agent-event-runtime` | Publish each native initialization diagnostic once in a stable session sequence | P3 | H7.unknown-held corpus, excluded until fixed |
| H-27 | Codex rate-limit diagnostics changed count under one session; [two recordings and diff](../../packages/harness/e2e/corpus/races/H37.options-per-turn.json) | Correctness | Codex runtime diagnostic publication | Publish a stable rate-limit diagnostic sequence for the turn | P3 | H37.options-per-turn corpus, excluded until fixed |
| H-28 | H1 emitted `runtime.mcp_server_status` and `codex_app_server.unmapped_event` in opposite order for one session; the first comparison differed at `$.observations.25.entities.7.frames.4.data.payload.id`, and 20 targeted retries did not reproduce it, so a paired capture is pending | Correctness | Codex runtime diagnostic publication | Serialize same-session diagnostic events | P3 | H1-turn-parts corpus, excluded until fixed |
| C-1 | Hosted never delivers provider credentials to a cloud sandbox | Availability | `supervisor/sandbox.ts:108` is the only caller | The delivery path run on hosted, over the existing brokering | P2 cloud | H19 (local and live), H30 |
| C-2 | Hosted has no settings store and never sends the settings snapshot; its provider screen is a stub | Availability | `config-sync.ts` (self-hosted only); `routes/hosted/shell.ts:170-175` | A D1 settings store, snapshot push and fan-out on hosted | P2 cloud | H28 |
| C-3 | OpenCode fails in a hosted sandbox | Availability | `runtime-boot.ts:141-143`, `workspace/runtime.ts:564-568` | Composed when a session asks for it | P2 OpenCode, cloud | H19, OpenCode case |
| C-4 | Custom ACP harnesses fail in any sandbox | Availability | `workspace/runtime.ts:927-931` | Connections delivered in the snapshot (C-2), secrets resolved (C-10) | P2 cloud | H32 |
| C-5 | Self-hosted snapshot sending fails by default: no key pair, and plain-HTTP key discovery is refused | Availability | `runtime-access-token.ts:161-167`, `management-auth.ts:83-88` | Keys created at first start; a pinned verification key | P2 cloud | H29 |
| C-6 | No screen can allow a credential for cloud use (`shared`) | Availability | `provider-connect-form.tsx` (prop never set); `PATCH /credentials/:id/scope` unused | A per-account consent toggle in v2 Settings | P2 cloud, app v2 | H30 |
| C-7 | Default-harness changes never reach running sandboxes; commands are never sent; plugins never arrive on self-hosted | Correctness | `harness-routes.ts:42-58`, the snapshot builder, `workspace-runtime/src/cli.ts:63-66` | Fan-out, commands in the snapshot, plugin apply on self-hosted | P2 cloud | H33 |
| C-8 | The person's MCP servers are always dropped for cloud sandboxes | Availability | `agent-config/index.ts:588` | Filtered per server, not dropped | P2 cloud | H28 |
| C-9 | The startup harness key is half-renamed: drivers write `WORKSPACE_RUNTIME_RUNNER`, the runtime reads other names | Correctness | `sandbox-manager/src/runtime-env.ts:51`, `runtime-boot.ts:99-113` | One name, written and read | P2 cloud | H19, default-harness case |
| C-10 | The sandbox-side secret resolver isn't connected | Availability | `connection-secrets.ts:84` (no callers); `workspace/runtime.ts:920-925` | Connected through the registry | P2 cloud | H32 |
| C-11 | OpenCode never receives provider credentials in any sandbox | Availability | `opencode-runtime.ts:15` | Providers bound | P2 OpenCode | H19, OpenCode case |
| C-12 | Accounts are picked per org everywhere, never per person | Correctness, security | `registry.ts:185`; activation carries no actor; the broker's identity is `"operator"` | Owner written, actor carried, credentials chosen by the session's owner (`StartInput.owner`, `selectSessionCredentials`) | P1.3, P2 cloud | H31 |
| C-13 | Three agent programs in the image come from unpinned `curl \| bash` installers | Security (supply chain) | the sandbox Dockerfiles | Pinned by version and checksum | P2 cloud | An image check that fails on any unpinned install |
| C-14 | Unsigned desktop onboarding offers a cloud sandbox the daemon can't create (404), and saves a driver key nothing uses | UX | `execution-step.tsx:54`, `workspace-control-routes.ts:54` | v2 onboarding offers cloud only when a control plane that can create one is connected | App v2 | H34 |
| T-1 | An e2e spec sets the dead startup key, so it likely tests nothing | Test | `real-session-directory-isolation.spec.ts:96` | Sets the real key, with a red run | P2 cloud, with C-9 | Its own red run |
| T-2 | The sandbox worker's README cites a script that doesn't exist | Docs | `cloudflare-worker/README.md:92` | Fixed or removed | P2 cloud | — |
| T-3 | `build:packages` is red on `dev`: `switchHarness` exceeds the lint gate's complexity limit (47) | Build | `agent-sdk-runtime/src/runtime/handoff-transaction.ts` | Split into named steps | P0 | Fixed in 5d6aa44139 |
| T-4 | The architecture ratchets are red on `dev`: two Daytona scratch scripts that can't be committed as they are | Build | `sandbox-manager/verify-daytona-live*.ts` | Deleted | P0 | Fixed in fb1f0d5579 |
| T-5 | The app typecheck is red on `dev`: raw values where the theme requires tokens | Build | `claxedo-app/src/app/styles/index.css` | `--radius-pill` and an exact-value `--shadow-thumb` token | P0 | Fixed in fb1f0d5579 |
| T-6 | Unit suites and smoke scripts touch the developer's real harness state: the Claude CLI test writes `~/.claude/projects` transcripts the usage scanner counts, local-server tests and the server closure smoke rewrite `~/.codex/config.toml`, and SDK tests start the real `codex app-server` against `api.openai.com` with the developer's login | Test, security | `agent-sdk-runtime` and `workspace-runtime` preloads; `claxedo-local-server` vitest has none; `claxedo-server` closure smoke | A throwaway HOME for every suite and smoke, and no test reaching a vendor | P0 | The bun suites' preload landed in 7affdc4bec; local-server, the smoke and the vendor calls remain |
| T-7 | The real-spawn terminal test drops output printed before its client attaches: its fake socket ignores the binary attach checkpoint | Test | `workspace-runtime/src/pty/real-spawn.test.ts` | The socket reads the checkpoint's screen | P0 | Fixed in b33b9de0e7 |
| T-8 | Three desktop boot tests race the product on a loaded machine: one reads the discovery record after health (it's written only before the ready message), one kills the daemon before terminal history reaches disk, one uses an idle grace shorter than the identity read before ready | Test | `claxedo-desktop/scripts/claxedo-server-boot.test.ts` | Wait for what the product guarantees: the ready message, the history file, a grace longer than the identity read | P0 | Fixed in 86c897772a; each failed under 28 CPU burners before and passes after |
| T-9 | The flows spawned whatever `node` the shell resolved. In the lanes' shells that was `/usr/local/bin/node` v22.13.1, which segfaults in `better-sqlite3` on this machine (even `:memory:`, even rebuilt), so the daemon died opening its database. The harness never checked the runtime against `claxedo-server`'s `engines.node` | Test | `packages/harness/e2e/harness/daemon.ts`, `health.ts` | The daemon runs on a Node inside `engines.node` (`CLAXEDO_E2E_NODE`, refused otherwise); a crashed daemon is reported at once | P0 | Fixed in d6f6a51438, whose message wrongly blames Node 26; Node 26 was never the crashing runtime |
| T-10 | Running `workspace-runtime`'s tests east of UTC sent SIGTERM, then SIGKILL, to every process the user owns (the Claude app, every lane, Chrome). `bun test` parses dates in UTC but leaves `TZ` unset, so `ps` printed `lstart` in local time and every start read hours late. Launchd then read as newly spawned, and the PTY test that fakes pid 1 recorded it, so retirement sent `kill(-1)` and swept launchd's whole tree. Made-up PTY pids from 52000 also landed on real processes. `dev` has the same code in `agent-sdk-runtime/src/launch/identity.ts` | Safety | `process-ownership/src/launch/identity.ts`, `retirement.ts`, `descendants.ts`; `pty/history-restore.test.ts` | `ps` reads in `TZ=UTC0 LC_ALL=C`, parsed as UTC; pid 0 and 1 are never ownable, so nothing signals their groups or captures their trees; fake pids above every kernel's ceiling | P0 | Fixed on `feat/harness-v2`; `dev` still has it |

## The goal

1. **Budgets, each gated by the ratchet:**

   | Part | At the merge | After P6 |
   | --- | --- | --- |
   | The harness core | ≤ 5.65k | ≤ 5.65k |
   | Transports and profiles | ≤ 10.05k | ≤ 7.95k |
   | **`packages/harness` total** | **≤ 15.7k** | **≤ 13.6k** |
   | `agent-runtime-contract`, the shared wire contract, counted separately | ≤ 3.5k | ≤ 3.5k |

   **The core is well under 10k. The harness total is not,** and a total under 10k isn't reachable without cutting behavior. Decision 12 sets the accepted numbers before P1.
2. **Today's server contracts,** proven by the wire corpus.
3. **No behavior change for users,** apart from the approved changes below.
4. **One contract** (`HarnessTransport`, the broker interfaces, the services) with the complete [operation map](#the-operation-map).
5. **Transports never touch the store and never decide policy.**
6. **Harnesses you bring are first-class,** within what each can take.
7. **Moved, not rebuilt,** wherever fixes accumulated or other systems read the result.
8. **No swallowed errors, no polling,** and process-wide state only in named owners.
9. **No comments** in the new work.
10. **Tests:** real-stack flows, two corpora, and focused invariant tests where a flow can't reach an invariant deterministically.
11. **Every defect in the register fixed,** each with its regression test red on `dev` and green on the branch.
12. **One cloud delivery path** for hosted and self-hosted, proven by a live cloud turn per harness on staging.

## Rulings this plan implements

- **Harnesses kept:**
  - Claude (Agent SDK), Codex (app-server) and Cursor (`@cursor/sdk`), first-party;
  - generic ACP;
  - Pi as a custom harness, running the user's own Pi for the machine owner;
  - OpenCode through its embedded engine (decision 2);
  - goal mode, including evaluated goals.
- **Dropped:** the OpenCode server adapter. A remote OpenCode connects as an ACP agent (`opencode acp`).
- **Projection follows each harness's docs, not the connection.** Remote harnesses get only what their API accepts.
- **Transports and profiles are folders, not packages.**
- **npm is not a constraint.**
- **Integration management is a separate system.**
- **Layer over harnesses, never own their internals.**
- **All defects are fixed in this plan, as part of v2.** Nothing lands separately first. UI pieces go into the app plan's v2.
- **Earlier rulings:** D6, D7, D10, D13, D14; no backward compatibility.

## No backward compatibility

Nothing is released and nobody depends on this codebase (owner ruling, 2026-09-25), so nothing is kept for compatibility.

- **No migrations and no dual readers.** Stored config, stored runtime data and grants change shape whenever the new design is better. Old shapes are dropped, not converted.
- **What stays, and why:** the server contracts both apps in this repo read (routes, events, the stored messages the routes return) stay, as a scope choice ("Why today's server contracts"), not as a compatibility promise. The recovery engine and its tables move with the runtime host because it uses them.
- **npm.** 13 `@claxedo/*` packages are published; `npm view` on 2026-09-24 showed the harness libraries at 0.8.0. The CLI depends on them because it can't be bundled into one file: the embedded OpenCode host, `better-sqlite3` and `koffi` are native.
  - This plan publishes nothing.
  - The embedded engine stays (decision 2), so that blocker stays.
  - The rest is its own plan.
- **Pi.** Owner sessions move to the user's own Pi session directory. Member sessions keep today's brokered profiles.
- **No switches and no bridge.** The runtime cuts over to the new transports in one slice (decision 14).

## Areas that need extra care

### 1. Translators: moved, not rebuilt

**Fix history since the fork, by commit subject:**

| Path | Fix commits |
| --- | --- |
| `agent-event-runtime/src/harnesses` | 35 of 72 |
| `agent-sdk-runtime/src/harnesses` | 117 of 245 |
| the four packages together | 197 of 409 |

**The rules:**
- **Each translator moves into its transport folder as it is.** Only its import paths change.
- **Shared translator code moves unchanged into `src/translate/`:** the runner and state (`core/*`, 241 lines), `value.ts` (69), `host-subagent.ts`, `tool-attachments.ts` and `tool-display.ts` (242).
- **The event contracts move to `agent-runtime-contract`,** because the apps read them.
- **Two translators import the client-presentation projection.** Those imports point at its new home in `workspace-runtime` through a narrow re-export, until P6 removes them.
- **P0.5 maps every test case and every fix commit** in the four packages before anything moves ([Tests](#tests)).
- **Protocol recovery stays in its transport:** Codex thread resume, ACP restoration and quarantine, and ACP history reconstruction.
  - ACP restoration writes the handoff context **before** it rebinds the native session (`acp/turn-runner.ts:550`).
  - After the change it does so through `SessionBroker.persistHandoff`, which acknowledges the write before the transport rebinds.

### 2. Requests: permissions, questions, elicitation

This is a security boundary. The broker takes over what today's code enforces, and corrects one existing defect:

- **Who may answer:** the route's `SessionAccessPolicy` decides, as today: the creator, a participant, or a `send` share (`session-access-policy.ts:388-393`). The broker never decides who.
- **Which request:**
  - A turn request is keyed by session, workspace, owner generation, turn and the harness's upstream session.
  - An ACP startup request is keyed by session, operation id, workspace, connection and directory (`acp/elicitation.ts:127-132`), and lives until the session starts.
- **Answers:**
  - a chosen option (an absent option list isn't the same as an empty one);
  - free text;
  - a structured form, validated in ACP's shared pool;
  - a rejection.
- **Stale, duplicate, foreign:** refused with a typed error and no change. Routes already refuse ordinary duplicates (`session-core.ts:2892`).
- **Grants ("allow always"):**
  - scoped to the session and stored in `permissionState`;
  - keyed by the harness connection plus a key the transport computes from what the harness asks (Claude's command, Codex's request with callback fields removed plus directory and mode, ACP's kind and title); today's stored grants aren't carried over;
  - checked by the broker before asking, and an automatic answer is a recorded broker event;
  - saved before the allow is released.
- **Option substitution as today:** never widen "once" to "always"; "deny" may become "reject always"; answer `cancelled` when nothing fits (`acp/permission-options.ts:21-34`).
- **Save, then release.** The SDK path does this today. **ACP releases first** (`acp/index.ts:609-610`); this plan fixes it (H-3).
- **Cancel:** each protocol's own cancel answer: ACP `cancelled`, `deny` on the SDK path. Never "allow".
- **Expiry:** a harness can expire its own dialog (Pi dialogs carry a `timeout`). The request then ends as `expired`.
- **Permission-mode limits:** the ceiling helpers (`permission-ceiling.ts`, 65 lines) move into the broker. Every mode a transport reports declares its `level`.

### 3. Process ownership: its own package, first

- **P0.1 moves it unchanged into `packages/process-ownership`.** Every importer points there directly: 21 production files in `agent-sdk-runtime`, the 14 importers of `process-observer`, `workspace-runtime`, the desktop's `daemon-recovery.ts` and `server-daemon-discovery.ts`, and the CLI's `connect/desktop-daemon.ts`.
- **Transports never import it.** They call `services.spawn`, which `workspace-runtime` implements over it.
- **The launch-gate child's packaging moves with it.** These are all the sites:
  - `agent-sdk-runtime/scripts/build.ts:80-85`;
  - `check-package.ts:39`;
  - `claxedo-desktop/electron.vite.config.ts:86`;
  - `electron-builder.config.ts:177`;
  - `scripts/verify-package-contents.ts:255`;
  - `claxedo-server/scripts/sandbox/build-sandbox-image.ts:321`;
  - `claxedo-desktop/src/main/diagnostics/spawn-inventory.ts:409`;
  - `launch-gate.ts:282`;
  - the v2 e2e harness's `workspace-dists.ts:14`.
- **Its existing tests move with it.** Windows is covered by H23 once the Windows lane exists (P0.1).

### 4. Pi and credentials

**A session runs on its owner's credentials, whoever sends the turn** (owner ruling, 2026-09-25):
- **`StartInput.owner` names the session's owner,** and the profile is chosen once, at start and attach.
- **The owner profile runs when** the session's owner is the machine owner **and** the runtime is the desktop or loopback daemon, for every turn in that session, including a member's turn through a `send` share and a queued prompt re-issued later.
- **Every other session runs brokered,** in a separate Claxedo-owned profile, and so does every cloud runtime.
- **The turn's sender reaches `TurnInput.origin`** for authorization and audit only. The routes already know a request's provenance (`session-access-policy.ts:689-691`, owner grants) and record the origin of queued and background turns (`session/delivery-owner.ts:227-231`).

**The owner's Pi folder is never written.** No `auth.json` scrub, no model overlays, no title extension, no managed-file deletion. Today's code would destroy the user's login (`pi/auth.ts:119-121`, `:160`).

Flows H18 and H20 check that the user's `auth.json` is byte-identical afterwards, and cover:
- the owner's turn;
- a member's turn through a `send` share, which spends the owner's profile;
- a queued re-issue;
- expired and missing accounts.

## What stays and what goes, for users

### Stays

Everything users see today on every harness:
- turns;
- Stop and its results, including `needs_action`;
- queued messages;
- permissions, questions and elicitation;
- grants;
- subagents;
- native and evaluated goals, including goal turns Codex starts itself;
- steering;
- config pickers on their declared timing;
- attachments;
- titles and renames;
- archive stopping a running turn;
- usage with quota windows;
- todos;
- commands (`/command`);
- fork and agent lists on ACP;
- history;
- configured MCP servers everywhere today;
- plugins on Claude, Codex and Cursor;
- cloud workspaces;
- silent provider recovery;
- the boot behavior above.

### Changes

- **A remote OpenCode connects as an ACP agent.** The external-server path (`OPENCODE_URL`) goes with the server adapter.
- **Pi, for the owner, runs the user's own Pi:**
  - their extensions, skills and settings;
  - their session directory;
  - their commands (`get_commands`);
  - every extension-UI method Pi's RPC defines, of which today's code handles five and drops the rest (`pi/driver.ts:551-559`).
- **ACP permission replies are saved before the agent is released** (H-3).
- **Remote harnesses stop receiving Claxedo's own MCP server and local-process MCP servers** ([Remote harnesses](#remote-harnesses-what-reaches-them-and-what-doesnt)). They also show a notice, if decision 16 approves it.

### Goes

- **The OpenCode server adapter,** which fails every turn that asks permission (H-7).
- **`executeCommand` and the engine's `getMessagePage`.** No app calls `POST /session/:id/command`, which then answers 501 like `shell`; message pages already come from the runtime store (`workspace/runtime.ts`).
- **`shell`, `summarize`, `revert` and `unrevert`,** which nothing implements. Their routes keep answering 501 (`unsupportedIfUnavailable`).

## What stays and what goes, in the code

### Moved unchanged

| Module | Lines | Lands in |
| --- | --- | --- |
| Launch and process ownership | 2,222 | `packages/process-ownership` |
| Runtime host: `runtime.ts` and `runtime/*`, with recovery, admission, goal controller, titles and handoff | 3,604 | `workspace-runtime/src/host/` |
| Projection: `client-presentation/*`, `compat-events.ts`, `turn-projection.ts`, `child-event-routing.ts`, `sse.ts` | 3,181 | `workspace-runtime/src/projection/` |
| Event contracts, `agent-event-runtime/src/contracts` | 458 | `agent-runtime-contract` |
| Translators: Claude (1,412 + `partial-json.ts` 98), Codex 1,313, Cursor 691, ACP 1,538, Pi 192 (comments removed, blank lines kept) | ~5.2k | `src/transports/*/translate/` |
| Shared translator code | 552 | `src/translate/` |
| ACP restoration, quarantine, history reconstruction, `process-retirement.ts`, the restoration half of `acp/recovery.ts` | ~0.4k | `src/transports/acp/restore/` |

### Goes, as whole files

| Group | Lines | When |
| --- | --- | --- |
| Generated Codex protocol (605 files), generated at build from a pinned `@openai/codex` | 6,713 | P0.3 |
| Harness factories (no production consumer) | 100 | P0.3 |
| `shell`, `summarize`, `revert`, `unrevert` contracts and callers; routes keep 501 | ~50 + callers | P0.3 |
| Test stores, moved to test support | 1,860 | P4, with the last test importer mapped |
| Pi pin, `agent-dir.ts` override and title extension, for owner sessions only | 258 | P1.3 |
| OpenCode server adapter (`opencode-server-adapter`) | 1.3k | P4 |
| `adapters.ts`, `log.ts`, `target.ts`, `paths.ts` | 216 | with their last importer (13, 15, 8 and 2 production importers today) |
| Plugin projection adapters in the local server | 686 | P2, as profiles |
| Drifted `AgentRuntimeEvent` copy | ~50 | P1 |

### Rebuilt (estimated)

| Module | Today | After |
| --- | --- | --- |
| Contract: every operation, groups, services | ~2.2k | 1.2k |
| Broker: requests with grants and ceilings, startup requests, subagents, native-goal plumbing and provider turns, usage (in-turn and session), cancel | ~5.0k across drivers, host and interactions | 2.3k |
| Registry: custom-harness providers (the five hooks), credentials with turn-origin selection, config and credential refresh | 2,129 | 0.9k |
| Capabilities, models, MCP resolution with the remote filter, draft config reads | 1,058 | 0.45k |
| Profiles: format per harness, delivery per transport | 686 + scattered | 0.6k |
| Drivers: Claude 0.55k, Codex 0.8k, Cursor 0.9k (with a worker per binding), ACP 1.4k (with `restore/`), Pi 0.45k | ~9.9k | 4.1k |

### Budget per part (enforced by a ratchet)

| Part | At the merge | After P6 |
| --- | --- | --- |
| Contract | 1.2k | 1.2k |
| `src/translate/` (moved) | 0.55k | 0.55k |
| Broker | 2.3k | 2.3k |
| Registry and credentials | 0.9k | 0.9k |
| Capabilities | 0.45k | 0.45k |
| `IntegrationSource` | 0.15k | 0.15k |
| Build scripts | 0.1k | 0.1k |
| **Core** | **≤ 5.65k** | **≤ 5.65k** |
| Claude: driver 0.55k + translator 1.51k | 2.1k | 1.35k |
| Codex: driver 0.8k + translator | 2.15k | 1.6k |
| Cursor: driver and worker host 0.9k + translator | 1.6k | 1.35k |
| ACP: driver and restore 1.4k + translator | 2.95k | 2.4k |
| Pi | 0.65k | 0.65k |
| Profiles | 0.6k | 0.6k |
| **Transports and profiles** | **≤ 10.05k** | **≤ 7.95k** |
| **`packages/harness`** | **≤ 15.7k** | **≤ 13.6k** |
| `agent-runtime-contract` (today 3.2k; `recovery.ts` 866 kept; 458 event contracts moved in; duplicates removed), re-measured in P0.7 | ≤ 3.5k | ≤ 3.5k |
| OpenCode transport: the embedded engine moved from `workspace-runtime` (2.97k today), not re-estimated | +3.0k | +3.0k |

**How the numbers work:**
- "At the merge" translators are measured moved sizes. "After P6" is the review's rewrite estimate, reached only through corpus-proven slices.
- Rebuilt sizes are estimates, ±20–25%.
- **Missing a gate goes back to you.**

## Transports and harness profiles

A **transport** is how Claxedo drives a harness and reads its events. A **profile** is what the harness is: the documented **format** of its skills, MCP config and plugins, and whether projection adds to or replaces the user's own setup. **Delivery** of that format differs by transport, so each profile names its delivery per transport.

| Harness | Format (from its docs; P0.6 cites them) | Delivery |
| --- | --- | --- |
| Claude Code | plugin folders (`.claude-plugin/plugin.json`, `.mcp.json`) | Claude SDK: the `plugins` option (`claude/driver.ts:209-216`). `claude-agent-acp`: only its `_meta.claudeCode.options`, a version-checked ACP extension file. The wrapper passes `settingSources: ["user", "project", "local"]` and no `plugins` option, so folders alone don't reach it |
| Codex | a marketplace block and plugin cache in `config.toml` | The transport composes `CODEX_HOME` from the credentials plus the profile's fragments. Today a brokered home is deleted and rebuilt with only the broker's `config.toml` (`codex/broker.ts:47-52`), so brokered Codex likely loses plugins today. P0.2 checks this on `dev` (H-4) |
| Cursor | `~/.cursor/plugins/local` with `settingSources: ["plugins"]` | A machine-wide folder: the last projection wins across workspaces. The profile records "machine-scoped", and an exact per-session selection is refused, as today (`adapters/cursor.ts:62`) |
| OpenCode | skills, MCP servers, plugins and instructions as the engine's host hooks take them (`catalog`, `tool`, `mcp`, `skill`) | In process, through the host hooks; nothing is written into the person's project |
| Pi | its skills and extension locations, per its docs (P0.6) | Pi's own flags, adding to the user's setup, never replacing it |
| An ACP agent with no profile | none | Only MCP servers in `session/new`, through the remote filter when remote |

**What a profile never grants:**
- **The name and version an ACP agent reports are descriptive only.** They can select a profile's format, but never grant plugin authority. That needs an explicit, endpoint-bound binding, which comes with the integration plan.
- **Profiles for custom-harness plugins** also need management changes (the activation allowlist, `runtime-token.ts:47`, secret delivery), which come with the integration plan.

## Remote harnesses: what reaches them and what doesn't

A **remote harness** is one Claxedo doesn't start: an ACP agent over `streamable-http` or `websocket`. `StartInput.locality` says which kind it is.

| | Local (Claxedo starts it) | Remote |
| --- | --- | --- |
| Skills, plugin folders, config | through its profile | **not sent** |
| **Claxedo's own MCP server** | when tool groups are enabled (it's optional, `first-party-mcp/index.ts:48`) | **never.** Its URL is loopback (`:22`), and its bearer acts as the workspace owner for 24 hours (`credential.ts:35`). **Today it is sent to every ACP session, remote ones included** (`process-manager.ts:343-348`) |
| Configured MCP servers | as today | only HTTP or SSE servers, and only if the agent declares `http` or `sse` in `mcpCapabilities` (ACP SDK 1.3.0 defines `http`, `sse` and an experimental `acp`, `types.gen.d.ts:1580`). A missing flag means unsupported. **Never stdio.** ACP makes stdio mandatory, so excluding it remotely is Claxedo's policy: a stdio server would start on the agent's machine, where the command doesn't exist. The experimental `acp` transport is out of scope |
| Plugin MCP servers | as today | **not sent** in this plan. Sending a gateway token (a sandbox pass, 30–60 minutes, not bound to a host) to another machine needs endpoint-bound consent from the integration plan |
| Model credentials | the broker's | the agent's own. A remote process's environment can't be set (`acp/connection-provider.ts:97` already refuses env bindings) |
| Files | this workspace | its own filesystem. Review and diffs match only on a shared folder |
| Stop | protocol cancel, then the process is stopped | protocol cancel only. ACP reports `unknown` even after its local prompt settles (`acp/cancellation.ts:78`), so the recovery operation ends `needs_action` |
| Restart | today's reconcile | can't be proven stopped, so the session stays `recovering` until the harness's own API answers. For generic ACP that answer doesn't exist, so the session stays blocked until the user acts |

**One filter** applies these rules at every ACP call that carries MCP servers: `session/new`, load, resume and fork. It also honors `supportsMcpServers: false`.

**The notice** (decision 16):
> This agent runs on another machine. Claxedo can send it MCP servers over HTTP, but not skills, plugin files, or local tools. It uses its own accounts, works on its own files, and Claxedo can ask it to stop but can't force it.

The notice needs:
- **an additive, approved field** on the connection reference: `locality`, plus what wasn't applied. `decodeConnection` builds its result from known fields, so today's app ignores the new ones;
- **the UI in v2,** owned by the app plan.

## Why a native transport exists

The ACP transport runs Claude, Codex and Cursor through their wrappers. **A native transport exists only while it carries something ACP doesn't.** Each one's `README.md` keeps the list.

| Native feature | Through ACP today |
| --- | --- |
| **Codex:** native goals with pause and resume, provider-started goal turns (`thread/goal/*`, `codex/goal.ts:352`) | Only through Claxedo's goal extension |
| **Codex:** steering (`turn/steer`) | No standard method |
| **Codex:** quota windows (`account/rateLimits/updated`) | No, unless `codex-acp` forwards them (unverified) |
| **Codex:** ChatGPT login and refresh, Claxedo subagents as Codex tools, background terminals | No |
| **Claude:** plugins through the SDK | Only through the wrapper's `_meta` extension |
| **Claude:** steering through streaming input (`claude/driver.ts:666-673`) | No |
| **Claude:** usage per owner, effort per turn, bypass mode | Partly |
| **Cursor:** its SDK's run status, `Agent.create` with plugin settings and MCP servers | Your ruling: the SDK |
| **Claude, Cursor goals:** start and stop only (`actions: []`) | The `/goal` command is prompt text and could travel over ACP |
| **Claude, Codex:** subagents | Yes (draft #1992) |

## Harness specifics

**The principle:** translate what the harness tells us, and never re-implement what it does.

- **ACP:**
  - capabilities from `initialize`;
  - negotiated extensions as version-checked files: subagents, goals, and `claude-agent-acp`'s options;
  - config options, modes, `_meta`, and usage from each prompt;
  - fork and agent lists;
  - bug workarounds in one table keyed by the reported name and version, each with a README entry and a corpus case;
  - the shared validation pool (two workers, 32 MB each, `pattern-validation.ts:8-20`) as a named process-wide owner.
- **Cursor:**
  - The SDK freezes its backend per process: `CURSOR_BACKEND_URL` is read at module scope, and there's no per-instance setting in 1.0.24. The transport runs the SDK in **one `worker_threads` worker per backend binding.** Each worker has its own module registry and environment, and events stream over a `MessagePort`.
  - Whether two workers on one workspace share the SDK's local state safely is checked by H25.
- **Pi:**
  - RPC events, with extension tools as ordinary tool calls;
  - commands through `get_commands`;
  - the nine extension-UI methods in Pi's RPC docs: the four dialogs through the broker (with `timeout` → `expired`), and `notify`, `setStatus`, `setWidget`, `setTitle` and `set_editor_text` as typed events. Where the app has no surface for one, it's shown as a notice.
- **OpenCode (embedded engine):**
  - permission and question requests through the broker, answered through the engine's interaction port;
  - message history and its pages come from the runtime store, as they do today.
- **Every transport:** events it doesn't recognize become a typed `unrecognized` event, visible and counted.

## The contract

`src/contract/` is everything a transport sees. P1.0 freezes it only when every row of the operation map below has a callable owner.

```ts
export interface HarnessTransport {
  readonly kind: TransportKind
  capabilities(context: CapabilityContext): Promise<HarnessCapabilities>
  start(input: StartInput, session: SessionBroker): Promise<HarnessSession>
  attach(binding: HarnessBinding, session: SessionBroker): Promise<HarnessSession>
  send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent>
  cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline): Promise<CancelOutcome>
  configure(update: ConfigUpdate): Promise<ConfigApplied>
  close(session: HarnessSession): Promise<void>
  dispose(): Promise<void>
  readonly steer?: SteerOperations
  readonly goals?: NativeGoalOperations
  readonly config?: ConfigOperations
  readonly history?: HistoryOperations
  readonly naming?: NamingOperations
  readonly commands?: CommandOperations
  readonly agents?: AgentListOperations
  readonly fork?: ForkOperations
  readonly health?: HealthOperations
}

export type RoutedEvent = { event: AgentRuntimeEvent; route?: { child: string }; source?: EventSource }

export interface SessionBroker {
  rebind(upstreamSessionId: string): Promise<void>
  persistHandoff(context: HandoffContext): Promise<void>
  admitProviderTurn(input: ProviderTurnInput, run: (broker: TurnBroker) => AsyncIterable<RoutedEvent>): Promise<ProviderTurnResult>
  meter(usage: OutsideTurnUsage): void
  goal: { read(): GoalSnapshot | null; publish(snapshot: GoalSnapshot | null): Promise<void> }
  config(): SessionConfig
  reportFailure(failure: OwnerFailure): void
}

export interface TurnBroker {
  readonly signal: AbortSignal
  readonly origin: TurnOrigin
  ask(request: TurnRequest): Promise<RequestAnswer>
  observeSubagent(observation: SubagentObservation): Promise<ChildSessionRef | undefined>
  associateChild(correlationKey: string, target: ChildTarget): void
  meter(usage: UsageRecord): void
}

export interface RequestBroker {
  list(scope: RequestScope): Promise<PendingRequest[]>
  answer(id: string, answer: RequestAnswer, actor: AuthorizedActor): Promise<AnswerResult>
  askAtStart(request: StartRequest): Promise<RequestAnswer>
}

export interface HarnessServices {
  spawn(command: SpawnCommand, options: SpawnOptions): Promise<OwnedProcess>
  firstPartyMcp(sessionId: string, locality: Locality): McpServer | undefined
  transcripts: TranscriptRegistrar
  validationPool: ValidationPool
  log: Logger
  clock: Clock
}
```

- **`StartInput` carries:**
  - directory, `locality`, model and config;
  - the instruction block, only when the capabilities declare `instructionChannel: "thread-start"` (other channels compose it per turn, as today);
  - the profile's projection;
  - resolved credentials selected by the session's owner.
- **`TurnInput` carries:** the prompt, origin, model, effort, the prior todos (the Claude translator's seed) and the per-turn system block for per-turn channels.
- **`ConfigUpdate`:** model, effort, permission mode, credential and placeholder renewals, MCP and projection changes. Each change carries its timing: `immediate`, `after-active-turns` (Pi refuses a mid-turn rotation) or `next-session` (Cursor's permission mode). `ConfigApplied` reports readiness, replacing `waitForConfigReady`.
- **Turn admission and fencing stay in the moved runtime host.** A transport keeps only its protocol's own active-turn state, as an instance field.

### The operation map

Every member of today's surface has one owner. The list is taken from `adapter-contract.ts` and `sdk-runtime-driver.ts` (Appendix C).

| Today | After |
| --- | --- |
| **`AgentHarnessAdapterCore`** | |
| `adapterCapabilities` (`runtime-config` → `setModel`) | `capabilities()`; model through `StartInput` and `configure` |
| `instructionChannel` | a capability field; the runtime composes per channel, as today, including the 501 gate |
| `commitsStreamEvents` | removed. The moved projection commits for every transport exactly as today's adapters did; the wire corpus proves it |
| `sessionConfigOwner` | capability `configOwner: harness \| runtime`; harness-owned config is read through `config.read` |
| `getSession`, `getMessages` | the runtime store for local harnesses (as today); `history` only for a transport whose harness owns its history |
| `createSession` | `start` |
| re-attach after restart (lazy today, from `upstreamSessionId`) | `attach` |
| `createHandoffSession`, `releaseHandoffSource` | the moved runtime host, over `start` and `close` |
| `updateSession` (title, archive) | `naming.rename`. Archive runs the runtime's cancel path, then marks archived |
| `generateTitle` | `naming.generateTitle`; the moved `session-titles.ts` decides when |
| `getSessionConfig`, `updateSessionConfig` | `config.read`, `config.update` |
| `deleteSession` | `close` |
| `readHarnessCapabilities` | `capabilities` |
| `executeTurn` | `send`, yielding routed events |
| `listCommands` | the moved command discovery (the SDK and ACP read it today, `sdk-runtime-adapter.ts:699`, `acp/index.ts:492`), plus the optional `commands.list` (Pi's `get_commands`) |
| `readConnectionState`, `readRuntimeHealth` | `health` |
| `dispose` | `dispose`: end turns, answer pending requests with their cancel, close |
| **Add-ons** | |
| `cancelTurn` | `cancel` |
| `steerTurn` | `steer.steer`, with the result states `accepted`, `unknown`, `unsupported`, `no_active_turn`, and the runtime's fallback to the queue |
| `forkSession` (ACP) | `fork` |
| `listAgents` (ACP) | `agents` |
| `getTodos` | the runtime store for `/session/:id/todo`; the seed through `TurnInput`; the `todos` capability flag |
| `goals`: `readCapabilities`, `read`, `start`, `pause`, `resume`, `stop`, `delete` | the `goals` group, with accepted and failed results and stop before interrupt |
| `listPermissions`, `respondPermission` | `RequestBroker.list`, `.answer` |
| `listQuestions`, `replyQuestion`, `rejectQuestion` | `RequestBroker.list`, `.answer` |
| `replySessionStartQuestion`, `rejectSessionStartQuestion` | `RequestBroker.answer` on a start request |
| `listDraftPermissionModes`, `listPermissionModes`, `setPermissionMode` | `config.permissionModes({ draft \| session })`, `config.setPermissionMode`; each mode with `level` |
| `probeConfigOptions`, `peekConfigOptions` | `config.options({ draft \| session, peek })` |
| `applyConfig`, `waitForConfigReady` | `configure` and `ConfigApplied` |
| `revert`, `unrevert`, `shell`, `summarize` | deleted; routes keep 501 |
| `executeCommand`, `getMessagePage` | deleted. No app calls the command route, which answers 501 like `shell`; message pages come from the runtime store |
| **`SdkRuntimeDriverHost`** | |
| `lifecycle` | the transport's own active-turn field; admission stays in the runtime |
| `pendingPermissions`, `pendingQuestions`, `updatePermissionState` | the broker's requests and grants |
| `processObserver` | `services.spawn` |
| `transcriptRegistrar` | `services.transcripts` |
| `bindSession`, `getAgentSessionId`, `getSessionForAgentSession` | `start`, `attach`, `SessionBroker.rebind`, and a registry lookup from upstream id to session |
| `getGoal`, `publishGoal` | `SessionBroker.goal` |
| `getSessionConfig` | `SessionBroker.config` |
| `runProviderTurn` | `SessionBroker.admitProviderTurn`, with an event sink and settlement |
| `meterUsage` (outside a turn) | `SessionBroker.meter` |
| **`SdkRuntimeTurnInput`** | |
| `ingest` | events yielded by `send` or the provider-turn runner |
| `associateChild`, `observeSubagent` | `TurnBroker` |
| `rebindAgentSession` | `SessionBroker.rebind` |
| `abort` | `TurnBroker.signal` |
| `sessionId`, `getAgentSessionId`, `input`, `directory`, `model` | `HarnessSession` and `TurnInput` |
| **`SdkRuntimeDriver`** | |
| `type`, `instructionChannel`, `interactions` | `kind`, `capabilities` |
| `goals`, `nativeGoal` (including `run(input, objective, onGoal)`) | the `goals` group, whose `run` streams through `admitProviderTurn` |
| `applyConfig` | `configure` |
| `createAgentSession`, `deleteAgentSession` | `start`, `close` |
| `createRuntime(threadId, todos)` | translator initialization with the session's state and `TurnInput.todos` |
| `runTurn` | `send` |
| `generateTitle`, `setAgentSessionTitle` | `naming` |
| `readRuntimeHealth` | `health` |
| `configOptions`, `peekConfigOptions`, `effortLevels`, `permissionModes`, `setPermissionMode` | the `config` group |
| `dispose` | `dispose` |
| **`ConnectionProvider`**: `validateConfig`, `immutableIdentity`, `project`, `resolve`, `createAdapter` | the registry's `CustomHarnessProvider`, with the same five hooks; `createAdapter` returns a transport; the `HarnessConnectionRef` wire shape is unchanged |
| `AgentInteractionResult.events`, `reportOwnerFailure` | returned by `RequestBroker.answer` and published by the route; `SessionBroker.reportFailure` feeds recovery inspection, as today |

## State machines

| Machine | States | Owner |
| --- | --- | --- |
| Request | asked, answered(answer), auto-answered(grant), refused(reason), cancelled, expired | the broker |
| Harness process | starting, ready, busy, retiring, exited(code), failed(class) | each transport, over `spawn` |
| Custom harness | configured, connecting, ready, auth-required, disconnected, failed(reason) | the registry |
| Native goal | none, running, paused, achieved, stopped, failed(class) | the transport's `goals` group, through the broker |
| Subagent | started, running, finished, failed(class) | the broker |
| Projection | none, applying, applied(generation), partial(not applied items), machine-scoped, failed(class) | the registry |
| Config change | pending(timing), applied, refused(reason) | the registry |

Turn, recovery-operation and evaluated-goal states stay in the moved runtime host, unchanged.

## Conventions and their checks

The conventions live in `packages/harness/AGENTS.md` (Appendix A). The checks run over `packages/harness` and must be at zero.

| Check | Fails on |
| --- | --- |
| No comments | Any comment that isn't a tool directive |
| Size | A file over 300 lines or a function over 40. Moved translator files are measured, and split only in their corpus-proven slice. Generated Codex types, emitted inside the Codex transport folder, are excluded |
| Core boundary | The core importing a transport, a profile, or a vendor SDK |
| Transport boundary | A transport importing anything but `src/contract/`, `src/translate/`, its profile, its own folder, its own vendor SDK, Node built-ins and `@claxedo/helpers` |
| No policy in transports | A transport answering a request, running a goal loop, or deciding when to title |
| Process-wide state | Module-level mutable state outside the owners listed in Appendix A |
| No swallowed errors | `.catch(() =>`, an empty `catch`, or matching error text outside each transport's `errors.ts` (named so `helpers/verify.ts` DIVERGENCE doesn't trip) |
| No polling | Timer loops outside named owners |
| One harness table | A harness-id list or `switch` outside `src/registry/` |
| Wire unchanged | Any difference in the wire corpus, apart from approved changes |
| Budget | A part over its ratchet |

**Architecture ratchets on every import-changing slice.** Each slice records which policy ceilings it moves, and re-measures them exactly with an updated policy comment:
- local server `69/29`;
- server `127/41`;
- desktop main `99/26`;
- the `isolation.buildPackages` lists (`local-server.ts:209-212`, `server.ts:151-154`), edited in P4.


## Tests

**Recommendation (decision 7):** flows, two corpora, and focused invariant tests.

**P0.5 maps every test case** before anything is deleted: 184 files, about 1,470 cases, about 4,255 assertions. It also maps every fix commit in the four packages (197 of 409). Each case goes:
- to a flow;
- to a corpus case;
- to a kept invariant test, moved with its code;
- or to a written reason.

**Kept as focused tests, at minimum:**
- stale steering (`turn-admission.test.ts:135`);
- save before approval (`sdk-runtime-interactions.test.ts:74`);
- elicitation validation races;
- descendant retirement (`retirement.test.ts:43`);
- grant keys per harness.

**The corpora:**
1. **Translator corpus.** Provider-boundary inputs plus each translator's initialization and context, and the expected `AgentRuntimeEvent`s.
   - It's recorded on `dev` through a tap on a throwaway branch that never merges.
   - It includes a **multi-step ACP turn**, where today's live and stored frames differ.
   - The 11 files in `harness-traces/` are presentation-level, so they're wire evidence only.
2. **Wire corpus.** For every scripted flow on `dev`:
   - live frames, stored messages, replay, child relationships;
   - control replies, including every recovery operation state and refusal kind, with HTTP status;
   - `GET …/operations/:id` after a restart;
   - terminal order;
   - **cross-channel identity:** the same turn's live and stored ids.

   Identity is normalized consistently. Time fields (`phaseDeadlineAt`, `observedAt`) are normalized; `state` and `phase` are not.

**Regression tests.** Each defect in the register has its test recorded **red on `dev`** in P0.2, before any fix, so every fix is proven by a test that caught the defect.

**Infrastructure P0.1 must deliver** before the flows that need it are gates:
- **a local brokering sandbox driver:** the `egress-broker` package behind a driver that declares `secretBrokering: "native"`, so cloud flows (H19, H28–H33) run locally with keys kept outside the sandbox. A live staging run per harness gives the final acceptance;
- the hosted stack run locally (`wrangler dev` with local D1), for the hosted delivery flows;
- a websocket scripted ACP agent (H16, H24);
- a local sandbox driver (H19);
- a Windows e2e lane (H23; today Windows CI runs only `bun test` suites);
- a Cursor scripted backend or recorded sessions (H25). If only recorded, those flows are evidence, not gates.

**Portability of the v2 e2e harness.** P0.1 edits:
- `app.ts:8-9`, `node-loader.ts:5-6`, `daemon.ts:18`, `desktop-build.ts:5`;
- `workspace-dists.ts:7,14` (the launch-gate child);
- `pinned-pi.ts:6,19` (the production Pi pin);
- `scripted-model-request.ts:5` (the production title prompt);
- `usage-pricing.ts:6`, `a11y.ts:8`;
- `stack.ts:47` (it needs the Vite-built app).

`--app=v2` needs `packages/claxedo-app-v2`, which isn't on `dev`. So this branch runs the baseline against today's app, and runs v2 only after decision 10's base branch includes it.

**Red runs** are targeted fault injections (a refused write, a killed process, a dropped frame), never the harness's generic "agent fails every turn".

**Cost.** About 90–100 flow-by-harness variants. The rules:
- a new flow passes 20 local runs once, when written;
- baseline parity runs 3 times per side per gate;
- full qualification happens at P5.

Runs are sharded by harness with separate `CLAXEDO_E2E_PORT_RANGE`s, on crabbox boxes.

**The flows.** **B**: must pass on `dev` and the branch. **N**: branch only. Each gate includes only flows whose transport exists at that phase and declares the capability.

| # | Flow | Mark |
| --- | --- | --- |
| H1 | A turn streams every part kind, each harness | B |
| H2 | Stop: each recovery operation state the harness can reach (`succeeded` with proven cleanup, `needs_action` otherwise), and a refused Stop | B |
| H3 | Permissions: once, always (an identical second call is silent, a different one prompts), deny; refused stale, duplicate and foreign replies | B |
| H3b | Save before release under a fault-injected save failure | B for the SDK path, N for ACP |
| H4 | Questions: free text, forms, ACP startup elicitation, URL consent, validation cancelled mid-way; Pi dialogs including `timeout` | B; N for Pi `timeout` |
| H5 | Subagents with usage attributed to the owner | B |
| H6 | Goals: start and stop (Claude, Cursor), pause and resume (Codex, an ACP agent with the extension), Codex provider-started turns, evaluated (Claude, Pi) | B |
| H7 | Steer, including an `unknown` result: the steer is held as provider-owned and never resent, because the harness may already have it (`session/delivery-owner.ts`) | B |
| H8 | Restart mid-turn: the session is `recovering`, 503 while launches are unresolved, then usable | B |
| H9 | Harness process dies mid-turn | B |
| H10 | Config changes on their declared timing, including a credential renewal during a long session and a refused widening of a child's permission mode | B |
| H11 | Attachments | B |
| H12 | Titles, rename, archive stopping a running turn | B |
| H13 | Usage, quota windows, and usage arriving after a turn ended (Codex) | B |
| H14 | Configured MCP servers on every local harness | B |
| H15 | Plugins through profiles: Claude SDK, Codex (including brokered, H-4), Cursor; Claude over `claude-agent-acp` through the `_meta` extension | B; N for brokered Codex and the ACP case |
| H16 | Custom ACP by command and by websocket; fork, agent list, commands | B once the websocket agent exists |
| H17 | OpenCode (embedded): permission and question prompts through the broker; owner credentials switched live without aborting a turn | N |
| H18 | Pi for the owner: an extension command via `get_commands`, `setStatus` and a widget; mismatched RPC; `auth.json` unchanged | N |
| H19 | Cloud workspace: one turn per harness | B once the sandbox driver exists |
| H20 | Pi credentials by session owner: the owner's turn, a member's turn through a `send` share (spends the owner's profile), a queued re-issue, expired and missing accounts | N |
| H21 | Two workspaces: an ACP config restart in one doesn't wait on the other | N |
| H22 | Checkpoint drain with `needs_action` handled as today | B |
| H23 | Windows: spawn, cancel, retirement | B once the Windows lane exists |
| H24 | Remote ACP: no first-party server, no `Authorization` for it, no stdio servers in `session/new`, load, resume or fork; the notice, if approved | N |
| H25 | Cursor with two backend bindings at once | N |
| H26 | ACP restoration: handoff context saved before rebinding | B |
| H27 | History and todos after restart | B |
| H28 | Hosted settings reach a sandbox: the person's HTTP MCP server with a brokered token arrives; a local-command MCP server arrives only if the image or an install spec provides it; a settings change reaches a running sandbox | N (C-2, C-8) |
| H29 | Self-hosted cold start with no key-pair environment: keys are created, the snapshot arrives, the sandbox is ready | N (C-5) |
| H30 | Cloud consent: allowing an account puts it in the sandbox as a placeholder; revoking it removes it; the real key never appears inside the sandbox | N (C-1, C-6) |
| H31 | Per-person accounts: two people, two accounts; each person's sessions spend their own; a member's turn in the owner's session spends the owner's | N (C-12) |
| H32 | A custom ACP harness with a secret runs in a cloud sandbox; the secret is leased, and refused once revoked | N (C-4, C-10) |
| H33 | A default-harness change, commands and a plugin reach a running self-hosted sandbox | N (C-7) |
| H34 | Unsigned desktop onboarding offers no cloud sandbox; signed onboarding does, and the workspace is created | N (C-14, app v2) |
| H35 | Harness switch mid-session: the transcript reaches the target harness, the handoff stays pending until a turn completes, switching back restores the source's own session, a failed target turn keeps the handoff, and rollback archives the prepared thread | B |
| H36 | Connection descriptors: malformed, duplicate, disabled, stale or retargeted descriptors are refused with typed errors, and a malformed first-party MCP entry never reaches a harness | B |
| H37 | Request refusals: an unknown session, an id bound to another workspace, a missing directory, an operation the harness doesn't implement, and a malformed provider binding are refused before any harness runs | B |

## Phases

Each phase ends with:
- its eligible flows green, on `dev` and the branch;
- both corpora unchanged;
- kept invariant tests green;
- checks at zero;
- the ratchet not raised;
- architecture ratchets green.

Every slice deletes what it replaces.

### P0: baseline, ownership, infrastructure

- [ ] **P0.1 Process ownership package and infrastructure.**
  - `packages/process-ownership`, with every importer and packaging site repointed; policies re-measured.
  - The portable e2e harness.
  - The websocket ACP agent, the sandbox driver, the Windows lane, the Cursor backend decision.
  - `Progress:` process ownership moved (8394b1378b); the portable harness runs H0 over ACP and pinned Pi with zero egress, green twice with a red run (71737a9fc5). The websocket agent, sandbox driver, Windows lane and Cursor decision remain.
- [ ] **P0.2 Baseline.**
  - Translator and wire corpora recorded on `dev`.
  - B flows green on `dev` with targeted red runs.
  - Every defect's regression test recorded red on `dev`, H-4 included.
  - `Progress:`
- [x] **P0.5 Invariant map,** per test case, plus every fix commit. It must finish before P0.3 deletes anything. `Progress:` done (`docs/harness-v2/invariant-map/`): 1,655 cases, of which 651 (39%) guard invariants no flow can observe and stay as focused tests, 503 are covered by flows, 483 by the two corpora, 18 are obsolete. The map adds flows H35 to H37 and lists the fix commits no test guards.
- [ ] **P0.3 Deletions:** the generated Codex protocol (generated at build, fresh-clone run), the harness factories, and the four add-ons with no implementer. `Progress:` the protocol is generated at build from Codex 0.133.0, the version the sandbox runs, with a test that fails when the pins drift (b5ff388d93). The factories and add-ons wait for the invariant map.
- [x] **P0.4 Checks and ratchet** at decision 12's numbers. `Progress:` `bun run check` in `packages/harness`, with a passing and a violating fixture per check and budgets in `budget.json` (1a1db3486d).
- [x] **P0.6 Profiles from docs** (`docs/harness-v2/profiles.md`):
  - format and delivery per transport, with citations;
  - whether projection adds to or replaces the user's setup;
  - `claude-agent-acp`'s `_meta` options;
  - OpenCode's config API;
  - Pi's skill and extension flags.
  - `Progress:`
- [x] **P0.7 Measurement manifest:** the file lists behind every number. `Progress:` done (`docs/harness-v2/measurements/`, `measure.sh` re-runs them). Every figure reproduced on `dev` except the projection (3,181, corrected here) and the Codex notification methods (65, corrected here). `agent-runtime-contract` is already 3,466 lines against its 3.5k budget, so P4's move of the 458 event-contract lines needs about 424 lines removed first, or a budget decision.

### P1: contract, broker, Pi

- [ ] **P1.0 Contract frozen:** the operation map complete, every row callable. `Progress:` the contract is in `packages/harness/src/contract/`; the transport lanes' proposals are folded in once by the contract pass (`hv2/contract-pass`).
- [ ] **P1.1 The runtime host and projection moved** into `workspace-runtime` unchanged, and `spawn` implemented. Wire corpus unchanged. `Progress:` `sse.ts` moved and the `spawn` service built over `process-ownership` (3658717af4). The host, the rest of the projection, `compat-events.ts`, `turn-projection.ts` and `child-event-routing.ts` move in the P3 cutover slice: today's drivers import them, so moving them earlier would invert the dependency.
- [ ] **P1.2 Broker:** requests with the full contract, grants and ceilings, start requests, subagents, goal plumbing and provider turns, usage, cancel. `Progress:` merged (0e3c8e2b99) with two review rounds' fixes (7039146100, ec4f6c5b56). Provider-turn admission, live rebind, abort-aware asks and outside-turn events come with the contract pass.
- [ ] **P1.4 Conformance suite** (`packages/harness/src/conformance/`): one set of cases every transport runs through the contract, with the real broker over in-memory runtime ports and the transport's real harness program behind the scripted model server or the scripted ACP agent. It carries the kept invariants the invariant map assigns to transports. `Progress:` `runConformance` runs the real Pi 0.85.1, the real Codex 0.133.0 and the scripted ACP agent (process and websocket) through the real broker; permission cases came with ACP (93d3b2e8a9).
- [ ] **P1.3 Pi transport and profile:**
  - the machine owner's sessions on their own Pi, whoever sends the turn; other owners' sessions brokered;
  - `get_commands`; all nine extension-UI methods (H-5, H-6);
  - the conformance suite green against the pinned Pi; H1, H4, H6, H12, H18 and H20 go green at the P3 cutover.
  - `Progress:` the transport (518 lines) and profile (94) merged (dd82818f5a); H18 and H20 red at H-5 and H-6 on today's adapter. Open: a `.js` Pi binary runs whatever `node` is on PATH, `process.env` defaults belong in the composition, and `commands.list` needs a live session.

### P2: transports, profiles and cloud delivery, in parallel

- [ ] **Claude SDK,** with the `claude-code` profile and its SDK delivery; the conformance suite green; H1–H15 eligible at P3. `Progress:` the transport (398 lines) and profile (38) are built in `hv2/claude-transport` with the real CLI in the suite; unmerged until the contract pass lands, then native goals, model and effort discovery, attachments, profile parity and its kept rows.
- [ ] **Codex app-server,** with `CODEX_HOME` composed from credentials and the profile (H-4); goals and provider turns; thread recovery; the conformance suite green; its flows at P3. `Progress:` merged (6c1cba7e5d): 666 lines, the composed home (H-4), projected MCP servers (H-10), the real Codex 0.133.0 in the suite. Open: provider-started goal turns end to end, and kept rows (the grant matrix, request-id concurrency, disposal during initialize, model precedence).
- [ ] **Cursor SDK,** with a worker per backend binding; the conformance suite green; H25 at P3. `Progress:`
- [ ] **ACP:**
  - one transport, extension files, `restore/`;
  - the remote filter at new, load, resume and fork;
  - no first-party server remotely;
  - save before release (H-3);
  - instance state, not a process-wide counter (H-8);
  - `claude-agent-acp`'s `_meta` delivery;
  - the conformance suite green; H16, H21, H24, H26 and defects H-1, H-2, H-3, H-8 green at P3.
  - `Progress:` merged (2ffc7cfc4a): the transport, `restore/`, process and websocket agents in the suite. Open: the draft probe and startup-request retirement (contract pass), streamable-HTTP conformance, optional handshake groups, and its kept rows.
- [ ] **OpenCode, one path: the embedded engine** (decision 2).
  - The engine moved from `workspace-runtime/src/opencode` behind `HarnessTransport` into `src/transports/opencode-sdk/`, split to the 300-line file limit.
  - Provider credentials in every placement (C-3, C-11), applied without aborting a running turn; requests through the broker.
  - The conformance suite green; H17 at P3.
  - The server adapter and `OPENCODE_URL` go in P4's package deletions (H-7).
  - `Progress:` decided 2026-09-25; part 1, the engine moved into the transport's folder, runs in `hv2/opencode-sdk`; part 2, the transport, follows the contract pass.
- [ ] **Cloud: one repository and hosted delivery (C-1, C-2).**
  - One repository for credentials and settings, D1 and SQLite behind it.
  - The delivery path run on hosted: brokered provider secrets per person, the settings snapshot, fan-out, credential reconciliation.
  - The static provider stub replaced.
  - H19 (local and live), H28, H30.
  - `Progress:`
- [ ] **Cloud: harnesses in sandboxes (C-3, C-4, C-9, C-10, C-11, T-1).**
  - One startup harness key.
  - Custom connections delivered, and their secrets resolved in the sandbox.
  - OpenCode with provider credentials.
  - H19, H32.
  - `Progress:`
- [ ] **Cloud: self-hosted (C-5, C-7):** signing keys created at first start with a pinned verification key; default-harness fan-out; commands in the snapshot; plugins on self-hosted. H29, H33. `Progress:`
- [ ] **Cloud: settings reach the sandbox (C-6, C-8, C-12):** per-account cloud consent, the person's MCP servers filtered instead of dropped, per-person account selection. H28, H30, H31. `Progress:`
- [ ] **Cloud: image and docs (C-13, T-2):** every agent program pinned by version and checksum; the README fixed. `Progress:`
- [ ] **App v2 items** (the consent toggle for C-6, C-14, decision 16), built through the app plan. H34. `Progress:`

### P3: the cutover

- [ ] The runtime host calls the contract for every harness in one slice, and every old adapter is deleted in the same slice. Every eligible flow green; both corpora unchanged. `Progress:`
- [ ] In the same slice: the runtime host and the rest of the projection move into `workspace-runtime`, and the subagent admission rules move into the broker, with the runtime store persisting only their state, so the broker's tests run the real rules instead of a fake. `Progress:`

### P4: cleanup

- [ ] The app-read types moved to `agent-runtime-contract`, with both apps' import paths changed in one change, coordinated with the app plan. `Progress:`
- [ ] The test stores moved to test support; `adapters.ts`, `log.ts`, `target.ts` and `paths.ts` gone with their last importer. `Progress:`
- [ ] `agent-sdk-runtime`, `agent-event-runtime` and `opencode-server-adapter` deleted; `isolation.buildPackages` edited; closures re-measured. `Progress:`

### P5: your review and the merge

- [ ] Every eligible flow green, corpora unchanged, invariant tests green, checks at zero, budgets met. `Progress:`
- [ ] You review each harness in the app. `Progress:`
- [ ] One merge. Nothing published. `Progress:`

### P6: translator slices (on `dev`)

- [ ] **Claude,** 1.51k → ≤ 0.8k. `Progress:`
- [ ] **Codex,** 1.35k → ≤ 0.8k. `Progress:`
- [ ] **Cursor,** 0.7k → ≤ 0.45k. `Progress:`
- [ ] **ACP,** 1.55k → ≤ 1.0k. `Progress:`
- [ ] The two translator imports of the projection removed. `Progress:`

Each is corpus-proven, with your sign-off.

## Execution: parallel lanes

**Setup:**
- The worktree has its own install.
- **The orchestrator freezes P1.0 first,** and owns `package.json`, `src/contract/` and `src/registry/`.
- **The Runtime lane owns the P3 cutover** in `workspace-runtime`.

| Lane | Owns | Delivers |
| --- | --- | --- |
| **Ownership** | `packages/process-ownership`, importers, packaging sites, policies | P0.1 ownership |
| **Infrastructure** | the portable e2e harness, websocket ACP agent, sandbox driver, Windows lane, Cursor backend | P0.1 infrastructure |
| **Baseline** | the tap branch and both corpora | P0.2 |
| **Map** | the invariant map | P0.5 |
| **Profiles** | `src/profiles/**` and the docs research, one agent per harness | P0.6, P2 profiles |
| **Checks** | checks, ratchet, manifest | P0.4, P0.7 |
| **Runtime** | the moved host and projection, `spawn`, the cutover | P1.1, P3 |
| **Broker** | `src/broker/**` | P1.2 |
| **Pi**, **Claude**, **Codex**, **Cursor**, **ACP**, **OpenCode** | their `src/transports/<kind>/**` | P1.3, P2 |
| **Cleanup** | app import paths (with the app plan), test stores, glue, package deletions | P4 |
| **Cloud: repository and hosted** | `claxedo-server-core` credentials and agent config, the D1 and SQLite repository, the hosted delivery routes | P2 cloud: C-1, C-2 |
| **Cloud: sandbox and self-hosted** | `sandbox-manager`, the supervisor, `runtime-boot.ts`, the sandbox images and worker | P2 cloud: C-3 to C-5, C-7, C-9 to C-11, C-13, T-1, T-2 |
| **Cloud: settings and identity** | cloud consent, the MCP filter, per-person selection (with the Broker and Pi lanes) | P2 cloud: C-6, C-8, C-12 |
| **App v2 items** | through the app plan's lanes | C-14, the consent toggle, decision 16 |

**Models and cost.**
- Lanes run on Fable, falling back to Opus when Fable is limited.
- Running this as a workflow needs your go-ahead.

**Review.**
- An agent's "done" is a claim until flows, corpora, invariant tests and checks agree.
- The broker, the Pi credential selection, the remote filter and the moves each get a second reviewer.

## Open decisions

1. **The counted boundary.**
   - **Recommendation:** `packages/harness` is gated. `agent-runtime-contract` is the shared wire contract, gated separately.
   - The moved runtime code and `process-ownership` count against their own packages.
2. **OpenCode: the embedded engine.** Decided by the owner on 2026-09-25, after the options were measured (`docs/harness-v2/opencode-options.md`).
   - One transport, `opencode-sdk`: today's embedded engine (`@opencode-ai/sdk` V2, in the daemon), moved behind `HarnessTransport`. One engine serves every folder of the runtime: 572 MB idle and 792 MB after a turn.
   - A session runs on its owner's credentials. The engine's provider overlay is process-wide, so the transport holds one owner's credentials and refuses a session whose owner differs instead of running it on another person's account.
   - Claxedo's own tools, skills, MCP servers, plugins and the provider allow-list reach the engine in process through its host hooks, each with the calling session's identity.
   - Accepted costs: an engine crash takes down the daemon, and the SDK keeps its five Node patches and the deep `EmbeddedHost` import.
   - Rejected: the v2 server (`opencode2 serve`). Its config is process-wide, so Claxedo's own tools can't tell which session is calling without a bearer valid for every session, and one server per folder or per session multiplies 686 MB. Also rejected: the v1 server adapter (`opencode-server-adapter`, H-7), deleted in P4; a remote OpenCode connects as an ACP agent.
3. **Harness switching mid-session.** It moves unchanged with the runtime host; nothing to decide here.
4. **Protocol recovery inside transports.** **Recommendation:** keep it.
5. **Pi credentials.** Decided 2026-09-25: credentials follow the session's owner, not the turn's sender.
   - The machine owner's sessions use their own Pi on the desktop or loopback daemon, for every turn.
   - Everything else is brokered.
6. **Pi MCP and owner titles.**
   - **Recommendation:** MCP follows Pi's docs (P0.6).
   - For owner sessions, use Pi's own session name when it sets one; otherwise the runtime's fallback title, because the injected title extension is gone.
7. **Tests.** **Recommendation:** flows, two corpora, and focused invariant tests.
8. **The integration system.**
   - Its own plan, carrying custom-harness plugins, endpoint-bound consent and remote plugin tokens.
   - Executor (`github.com/RhysSullivan/executor` at `fec546e`) isn't a fit to host.
9. **Recovery routes.** Settled: unchanged, with the engine moved.
10. **Base branch.**
    - **Recommendation:** off `dev`, with P0.1's portable harness first.
    - v2 flows run once `claxedo-app-v2` is on the base.
11. **Stopping the npm libraries.** Its own plan.
12. **The accepted totals, set before P1.**
    - `packages/harness` ≤ 15.7k at the merge and ≤ 13.6k after P6; `agent-runtime-contract` ≤ 3.5k.
    - **The core (≤ 5.65k) is the only part under 10k.**
    - Going lower means cutting behavior: OpenCode through ACP (−3.0k); Claude through `claude-agent-acp`, which loses SDK plugins, per-owner usage and per-turn effort.
    - **Recommendation:** accept.
13. **Adapters from third parties.** **Recommendation:** first-party only, until there's a trust model.
14. **The bridge or an atomic cutover.** Settled (2026-09-25): an atomic cutover, with no bridge. Each transport is proven by the conformance suite before P3; P3 cuts the runtime over once and the flows gate it.
15. **The turn row, one journal and write-once projection (D3)** go with the server-contract rebuild, not here. **Recommendation:** confirm.
16. **The remote notice:** the additive `locality` field and a not-applied list on the connection reference, with the UI in the app plan; or documentation only for now. **Recommendation:** the additive field.
17. **ACP save-before-release.** Settled: fixed in this plan (H-3).
18. **Brokered Codex plugins.** Settled: confirmed red on `dev` in P0.2 and fixed in the Codex transport (H-4).

19. **Cloud harnesses.** Settled: cloud delivery is part of this plan (P2). Install specs and profile bundles are the only new design, and can follow in a later slice.
20. **Sandbox drivers without secret brokering** (Docker, Modal, Box): refuse a turn that needs a provider key, as today, or allow putting the raw key in the sandbox with explicit consent.
    - **Recommendation:** keep refusing.

## Risks

1. **The contract misses an operation.** Mitigated by the operation map from the full member list, and P1.0 freezing only when every row is callable.
2. **Moves change behavior.** Mitigated by the wire corpus across live, stored, replay, control and cross-channel identity, and by the translator corpus with multi-step turns.
3. **Credentials.** A session's profile comes from its owner, never writes the user's folder, and is covered by H18 and H20.
4. **Remote leakage.** No first-party server, no stdio, and no plugin tokens go to remote harnesses; H24 covers it.
5. **Budgets.** Translators move at measured size; P6 needs corpus proof; a missed gate goes back to you.
6. **Qualification time.** About 90–100 variants, sharded on crabbox, with run counts per gate stated.
7. **Cross-plan coordination.** App import paths in P4, and the remote notice's UI, are shared with the app plan.
8. **Scope.** Cloud delivery widens the plan across the server. Mitigated by lanes with disjoint files, and a regression test per defect.

## Definition of done

- [ ] `packages/process-ownership` in place; no package cycle; desktop and CLI policies re-measured.
- [ ] `packages/harness` within decision 12's gates; the core ≤ 5.65k.
- [ ] Every row of the operation map implemented by its owner; no transport touches the store or decides policy.
- [ ] The broker's request contract, grants and ceilings in place; H2–H4 and H3b green.
- [ ] Runtime host, recovery engine and projection moved unchanged; the wire corpus identical, apart from approved changes.
- [ ] Translators moved; the invariant map complete; the translator corpus identical.
- [ ] Profiles with format and delivery per transport; H14 and H15 green.
- [ ] Remote rules in one filter; H24 green.
- [ ] Pi sessions on their owner's profile, the user's folder untouched; H18 and H20 green.
- [ ] Cursor workers per binding; H25 green.
- [ ] Old packages deleted; app import paths moved; `isolation.buildPackages` updated.
- [ ] Zero comments, no swallowed errors, process-wide state only in named owners; checks and architecture ratchets green.
- [ ] Eligible B flows green on `dev` and the branch, N flows on the branch, each with a targeted red run.
- [ ] Every defect in the register fixed; each regression test was red on `dev` and is green on the branch.
- [ ] One cloud delivery path on hosted and self-hosted; a live cloud turn per harness on staging (H19).
- [ ] You reviewed and approved; merged; everything passes on `dev`.

## Appendix A: `packages/harness/AGENTS.md`

Written in P0.1. A `CLAUDE.md` beside it contains `@AGENTS.md`. The repo root files are unchanged.

````markdown
# Claxedo harness

This package connects Claxedo to agent harnesses. The repo root `AGENTS.md` still applies; where the two differ, this file wins here.

## Parts

- **Core** (`src/contract/`, `src/broker/`, `src/registry/`, `src/capabilities/`, `src/translate/`): Claxedo's own concepts. It never imports a transport, a profile, or a vendor SDK.
- **Transports** (`src/transports/<kind>/`): how we drive one kind of harness and read its events. A transport imports only `src/contract/`, `src/translate/`, its profile, its own folder, its own vendor SDK, Node built-ins and `@claxedo/helpers`.
- **Profiles** (`src/profiles/<harness>/`): the documented format of a harness's skills, MCP config and plugins, and its delivery per transport. Every rule cites the doc it comes from. A profile never grants plugin authority.

## What a transport does and never does

- It implements `HarnessTransport` and the operation groups its harness supports, and declares its capabilities once.
- It starts every process through `services.spawn`.
- It never touches the store, answers a request, runs a goal loop, or decides when to title. It asks the broker.
- A native transport's `README.md` lists what it carries that ACP doesn't. When that list is empty, the transport goes.

## Remote harnesses

A harness Claxedo doesn't start gets only what its API accepts, through the one remote filter:
- never Claxedo's own MCP server or its bearer;
- never a stdio server;
- only HTTP or SSE servers the agent declares;
- no plugin tokens without the integration system's consent.

Never assume its files are ours, and never report a remote stop as proven.

## Areas that need extra care

- **Translators:** logic changes only in a corpus-proven slice with the owner's sign-off.
- **Requests:** the broker's contract is a security boundary. Who may answer is decided by the route; which request, which answer, grants and "save, then release" by the broker.
- **Credentials:** a transport reads credentials only from `StartInput`. The owner's own Pi profile runs only for a turn whose origin is the machine owner on a desktop or loopback runtime, and its folder is never written.

## Process-wide state

None, except these owners, each with its reason in its folder's `README.md`:
- the Cursor worker registry (the SDK freezes its backend per process);
- ACP's validation pool (two workers, 32 MB, shared on purpose).

Adding an owner adds it here.

## No comments

Code carries no comments. Names, types and small functions say what the code does; each folder's `README.md` says why; the corpora and flows say how it behaves. Tool directives stay.

## Files and state

- A file stays under 300 lines and a function under 40. Split along responsibilities; never compress.
- No `utils`, `helpers`, `common` or `misc`.
- Any state with more than two values is an explicit machine.

## Errors

Typed errors from each transport's `errors.ts`, with a class, `retryable` and a cause. No `.catch(() => default)`, no empty `catch`, no silent fallback, no retry loop apart from a harness's own protocol recovery named in its `README.md`.

## Tests

Real stack first: flows against real harnesses and the scripted model server; the translator corpus at the provider boundary; the wire corpus at public entrypoints. Focused tests only where the invariant map says a flow can't reach an invariant deterministically. Every flow has a targeted red run.

## Checks

`bun run check` runs: no comments, size, core boundary, transport boundary, no policy in transports, process-wide state, no swallowed errors, no polling, one harness table, wire unchanged, budget. All at zero before a change is done. `bun run test:architecture-ratchets` after every import change.
````

## Appendix B: review findings and what changed

**Three rounds:**
1. GPT-6 Astra review, 18 findings.
2. GPT-6 Astra re-review: not ready; 7 resolved, 11 partly resolved; 10 new.
3. A five-part adversarial review (contract, runtime, security, delivery, transports), each on Fable, read-only.

I verified every finding below against the code before changing the plan.

| Finding | Source | Change |
| --- | --- | --- |
| Stop and v2's `session-stop.ts` parse the recovery operation strictly; `needs_action` is the normal result; receipts are unique per caller and request; the daemon lifecycle uses the engine | re-review 1, runtime | The recovery engine, receipts and routes move unchanged; the turn row goes to the server rebuild (decision 15) |
| Boot marks sessions `recovering` and answers 503 while launches are unresolved | runtime | Kept as is; H8 asserts it |
| Writing each frame once changes ACP multi-step turns on the wire | runtime | Projection moves unchanged; the corpus records multi-step turns and cross-channel identity |
| The contract lacked re-attach, config and credential refresh, request replies, todos, outside-turn usage, goal publishing, a provider-turn event sink, child routing, `instructionChannel`, `sessionConfigOwner`, `listCommands`, archive, draft config reads, the `ConnectionProvider` hooks | re-review 2, contract | A full operation map from every member, with `attach`, `configure`, `RequestBroker`, `RoutedEvent` and the `SessionBroker` additions |
| Claxedo's own MCP server, with an owner-acting 24-hour bearer, goes to remote ACP agents; `mcpCapabilities` has no `stdio`; the URL is loopback and optional | security, re-review | One remote filter at every call; `firstPartyMcp` is optional and local-only; H24 |
| A session's credentials depend on who sends a turn | security | The profile comes from the session's owner and a sender never changes it; the owner's machine logins only on desktop or loopback |
| Today's Pi code would wipe the user's `auth.json` | security | The owner's folder is never written; H18 and H20 check it byte-for-byte |
| "Allow always" grants are answered inside transports; option substitution; permission-mode ceilings | security | Grants, substitution and ceilings in the broker, with `level` on every mode |
| Startup requests, free text and forms, the wider authority key, and who may answer | re-review, security | `RequestBroker` with start requests and answer variants; actor authorization stays in the routes |
| ACP releases the agent before saving the reply | re-review | H-3; H3b is N for ACP |
| Moving process ownership into `workspace-runtime` creates a cycle and breaks the desktop allowance | delivery, re-review | Its own dependency-free package, first; every packaging site listed |
| `adapters.ts`, `log.ts`, `target.ts` and `paths.ts` are live; the test stores' importers cross packages; deletions were planned before the invariant map | delivery | They go with their importers; stores move to test support in P4; P0.5 comes before P0.3 |
| Gates that can't be met at their phase; missing infrastructure; harness portability; qualification cost | delivery, re-review | Gates only for eligible flows; infrastructure in P0.1; the portability edit list; run counts and sharding |
| Ratchet ceilings, `isolation.buildPackages`, DIVERGENCE, app imports of `agent-event-runtime` | delivery | A per-slice ratchet checklist; the cutover in `workspace-runtime`; app import paths in P4 |
| Claude SDK plugins go through an SDK option; `claude-agent-acp` reads neither folders nor `plugins`; brokered Codex rebuilds its home; Cursor's folder is machine-wide | transports | Profile = format, with delivery per transport; H-4; machine-scoped Cursor |
| Cursor needs a host per binding, and the SDK has no per-instance setting | transports | A `worker_threads` worker per binding, budgeted |
| Translators import shared modules and vendor SDKs | transports | `src/translate/` moved unchanged; the transport boundary allows its vendor SDK |
| Goals: Claude and Cursor have no pause or resume; Claude steers; Pi has nine extension-UI methods and `get_commands`; OpenCode's reply endpoints | transports, re-review | H6, the native table, Pi specifics and OpenCode specifics corrected |
| ACP's shared validation pool; boot-time and gate caches | re-review | Named owners |
| Measurements: Claude plus `partial-json`, ownership 2,222, a test helper counted, scripts outside `src/` | re-review, delivery | Appendix C corrected |
| The UI notice had no permitted scope | re-review | Decision 16: an additive field, with the UI in the app plan |
| Cloud harnesses: the first trace saw only hosted and called things missing; a re-trace by three reviewers (desktop and daemon, credentials, hosted settings) found the design exists on the self-hosted path and is broken or unwired in 14 places | cloud re-trace | The Cloud harnesses section, defects C-1 to C-14, fixed in P2 cloud |

## Appendix C: measurements

Run from the repo root on `dev` at `37563dc802`. P0.7 commits the file manifest behind each figure.

| Figure | Value | Command |
| --- | --- | --- |
| Production lines, four packages | 29,684 + 15,512 + 3,216 + 1,275 = 49,687 | `find packages/<p>/src -name '*.ts' ! -name '*.test.ts' ! -path '*/test-utils/*' ! -path '*/test-support/*' ! -name 'test-temp-dir.ts' \| xargs cat \| wc -l` |
| Test lines | 42,765 | the same with the test patterns |
| Operation surface | 96 members: `AgentHarnessAdapterCore` 20; 26 across 17 `Supports*` add-ons; `AgentGoalResource` 7; `SdkRuntimeDriverHost` 14; `SdkRuntimeTurnInput` 10; `SdkRuntimeDriver` 19 | member extraction over `adapter-contract.ts` and `harnesses/shared/sdk-runtime-driver.ts` |
| Generated Codex protocol | 605 files, 6,713 lines; Codex 0.156.1 generates 726 files, 115 committed files differ, `ServerNotification` gains 19 methods, none removed | `codex app-server generate-ts --out <dir>`; method sets compared by `grep -o '"method": "[^"]*"'` |
| Moved translators (comments removed, blank lines kept) | Claude 1,412 + `partial-json.ts` 98; Codex 1,313; ACP 1,538; Cursor 691; Pi 192 | `grep -vcE '^\s*(//\|\*\|/\*\|\*/)' <files>` |
| Shared translator code | `core` 241, `value.ts` 69, `host-subagent` and `tool-*` 242; `contracts` 458 | `wc -l` |
| Moved runtime host | `runtime.ts` 829 + `runtime/*` 2,775 = 3,604 | `find packages/agent-sdk-runtime/src/runtime -name '*.ts' ! -name '*.test.ts'` |
| Moved projection | `client-presentation` 2,000, `compat-events` 471, `turn-projection` and `child-event-routing` 467, `sse` 243 = 3,181 | `wc -l` |
| Process ownership | `launch` 1,424 + `process-observer` 189 + `process-lifecycle` 418 + `windows-process` 120 + `spawn-env` 71 = 2,222 | `wc -l` |
| Fix commits by subject | event harnesses 35/72; SDK harnesses 117/245; launch 12/28; all four packages 197/409 | `git log --format=%s -- <path> \| grep -ci fix` |
| Module-level mutable sites | 14 (listed in P0.7's manifest) | `grep -nE '^(let \|(export )?const [A-Za-z_]+ = new (Map\|Set\|WeakMap))'`, constant tables excluded |
| Tests to map | 184 files, ~1,470 cases, ~4,255 assertions | `grep -c 'test('`, `grep -c 'expect('` over the test files |
| npm | 13 `@claxedo/*` packages; harness libraries at 0.8.0 | `npm view <name> version`, 2026-09-24 |
| Executor | 219k production lines; self-host needs 20 packages (~154k); one organization per self-hosted instance; approvals in `model` mode by default | `github.com/RhysSullivan/executor` at `fec546e` |
