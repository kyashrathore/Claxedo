# Review: durable agent base tier

Reviewed 2026-09-05 against working tree HEAD `ca3e488f7a`, the supplied attachment, and the published `@cloudflare/think@0.17.0` package. The attachment and repository plan are byte-identical. This is a design review, not implementation or a runtime compatibility proof.

**Verdict: keep the architectural direction; revise the machine protocol, credential lifecycle and delivery order before implementation.** The separation between a durable work session and a native code session is clearer than the earlier placement designs. Think removes the requirement to embed OpenCode or Pi into workerd. It does not remove Claxedo's responsibility for durable external operations, workspace ownership, authorization and product agent behavior.

This is also a product change: work sessions use Claxedo's Think agent. Pi and OpenCode run on machines. Extended Pi in workerd is not delivered by this plan; the plan explicitly places user extension code on machines. That is a coherent scope decision, but the user guide must say it directly.

**The existing flow that constrains the cutover.** In `packages/claxedo-server/src/channels/control-plane.ts:286`, channel `sendMessage()` receives a session ID, text and sender identity. It marks the text as external/untrusted, invokes `/session/:id/message` on `input.runtime.routes`, and uses `centralSessionRouteEvents()` with the runtime event hub to stream the result back. `abortSession()` invokes the same runtime's abort route at line 312 and returns its status. These are live central consumers. `packages/agent-sdk-runtime/src/index.ts:174` and `package.json:86` also export the session-environment contract publicly. The proposed change replaces those runtime calls with the agent object's durable submission and approval APIs; it needs to preserve sender authorization, cancellation and result delivery through the transition.

**1. [P1] A workspace revision is not a machine-operation identity, and Think's ledger does not close the remote-effect failure window.**

Plan locations: [lease step 1](../plans/2026-09-05-005-think-agent-base-tier-plan.md#54-machines-as-leased-caches), lines 150–158; Unit 4, line 271.

`lease:<session>:<revision>` aliases distinct jobs on the same checkout. After one successful run, another run with identical action input replays the old report; different input under the same key conflicts. Neither starts the requested new job. Conversely, after the sandbox accepted a job but before the object recorded its result, retrying the action can duplicate a child.

The published Think action documentation and source confirm a 30-second default timeout, deletion of ledger rows on thrown/timed-out execution, and reclamation/re-execution of explicitly keyed pending actions after five minutes. `_claimActionLedgerRow()` compares the input hash as well as the key. A settled result is replayable; an external side effect is not transactionally committed with that result. Evidence: published `docs/actions.md`, and source-map `think.ts` lines 270, 4582–4601, 6484–6561 and 8707–8774.

Give every requested machine job a host-minted logical operation ID, persisted before dispatch and reused across retries. Keep workspace revision as a separate resource version. Sandbox admission and child creation must deduplicate that same operation ID. Persist the child ID and reconcile it after ambiguous responses. Define start, wait, completion and cancellation separately so a long child run does not depend on one default-timeout action invocation. Disable unsafe stale reclamation until the downstream operation is demonstrably idempotent.

Acceptance: two intentional jobs at the same revision run separately; retries of either do not create another child; eviction after remote admission but before local settlement recovers the original child; timeout and disconnection remain unknown until reconciled. Audit remote MCP and other plain tools too: Think's action ledger only covers actions, not every exposed tool automatically.

**2. [P1] The workspace handoff can lose edits and has no defined safe unlock.**

Plan locations: lines 149–158 and Unit 4.

Step 3 captures/materializes the workspace before step 4 makes its tools read-only. A concurrent edit in that interval is absent from the machine snapshot and may be overwritten on return. Restricting tools alone also leaves future API or other workspace writers outside the lock. A machine holding uncommitted output is the only copy of those edits until checkpoint publication; during that interval it is not a disposable cache.

Fetching a commit does not itself install its tree into the object's working files. The plan needs to specify which commit, how dirty/untracked/deleted files return, and how a partial import is recovered. An idle agent also does not establish that every process writing its checkout has stopped.

Use an explicit ownership transition: `writable → leased(operation, epoch, baseRevision) → importing → writable(newRevision)`. Acquire ownership before export and enforce it in the authoritative workspace mutation layer. Publish a verified snapshot and install it atomically against the expected base/epoch before releasing the lease. Define private checkpoint commits or an archive policy for dirty output, exclude credentials, and reject stale child callbacks. If a child disappears, keep its ownership unresolved until reconciliation or confirmed termination makes transfer safe.

Acceptance: edit during export; duplicate or stale completion; crash during import; dirty and deleted files; child process still writing; archive path escape; and failed checkpoint followed by resume. The parent may continue chatting during an unknown job, but that must not implicitly restore workspace write authority.

**3. [P1] Per-turn front-door tokens do not cover autonomous turns, and sharing the parent's token overgrants children.**

Plan locations: line 122; Units 2, 5 and 6.

The Worker front mints a short-lived token, but an alarm, recovered turn or delayed approval can execute long after that request and token expire. There may be no new front-door request. Reusing the same token on the machine gives the child the parent's connector/model authority and still does not solve expiry during a long run.

Persist a grant reference and its owning principal, not a reusable upstream secret. Provide a trusted binding that checks current authorization and issues scoped credentials when a model call or action actually executes. Specify renewal, generation revocation and rejection after account/session access changes. Child grants should identify the child operation and permit only its required resources/actions. Gateway endpoint and redirect policy must prevent credential forwarding to an arbitrary compatible-provider URL.

Acceptance: schedule fires after token expiry with no browser; approval resumes after a day; access is revoked while parked; a child attempts a parent-only connector action; a provider redirects a credential-bearing request. Revocation should stop subsequent authorized calls, without promising to undo an already accepted remote effect.

**4. [P1] The Claude subscription adapter is not an available product integration as written.**

Plan location: provider table, line 130.

Anthropic explicitly disallows third-party applications routing requests through users' Free/Pro/Max credentials and collecting or intermediating Claude.ai tokens. Its documentation separately permits users to sign in to an unmodified hosted Claude Code binary, subject to its hosting conditions. Importing a Claude Code token into this gateway and forwarding it to Messages is the former case. A general terms footnote does not resolve that conflict. [Official authentication and credential-use policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

Scope Think's Claude support to API keys or supported inference providers unless a separate permitted arrangement is established. Keep native Claude Code authentication in the native harness flow. Treat each other subscription integration as a separately proven, permitted adapter; accepting an AI SDK model does not prove entitlement compatibility. The plan already correctly labels Antigravity access unverified.

**5. [P1] Central removal cannot ship independently of its current consumers' replacement or explicit retirement.**

Plan locations: Phase 0, lines 251–258; channels/wakes replacement in Unit 6, line 273; parallel execution, line 282.

Native Pi can ship independently. Removing central before Think exists leaves the channel message/abort path described above without its runtime. Search-based deletion of old identifiers also says nothing about persisted central sessions, queued wakes, pending approvals, existing links or public session-environment consumers.

Split the deliverable: native Pi first; prove the object; then cut over affected consumers and delete central together. Inventory persisted records and choose an explicit migration or retirement policy. A clean rewrite does not require a fallback runtime, but it does require a deliberate result for existing data and pending work. Make any intended temporary feature removal explicit instead of describing this phase as independently safe.

Acceptance: existing channel thread can send and cancel after cutover; pre-cutover wake/approval has one defined outcome; old session links have an intentional readable or retired state; public exports and all internal consumers change in the same reviewable slice. Keep the hosted import-graph and architecture-ratchet checks already required by the plan.

**6. [P2] Approval resolution must target a parked execution, not enqueue a generic turn.**

Plan locations: lines 167–168, Unit 5 and Unit 6.

`wake(result)` is described as enqueuing a turn, while approvals are described as resuming the parked turn. Those are different operations. Think exposes `pendingApprovals()`, `approveExecution(executionId)` and `rejectExecution(executionId)` for durable pauses. Store the mapping from the authorized wake approval to that execution and call the appropriate settlement API. A chat message saying approved must not authorize a tool.

For ordinary channel/event delivery, use durable submission with the originating event ID as its deduplication key; the published Think `docs/programmatic-submissions.md` describes `submitMessages()` for ambiguous delivery/retry. Preserve existing wake budget and serial-lane policy deliberately when moving time triggers to Agents schedules. Test duplicate ingress, duplicate approval, rejection, expired authorization and crash between settlement and receipt.

**7. [P2] Compaction and usage need concrete ownership before the base can promise long-lived conversations.**

Plan locations: lines 106–114, risk paragraph at line 213, and Unit 2 at line 266.

Think supplies compaction mechanisms, but its published `docs/index.md` states that overflow handling is opt-in and requires a configured compaction function and error classifier. Name the token budget, compaction callback, oversized-tool-result policy and gateway-backed model used for summaries. Test both between-turn and mid-turn overflow. Storage capacity does not establish a safe context or in-memory budget.

“Usage rows match assistant messages one to one” is not sufficient accounting acceptance: a message can involve multiple provider calls, retries, compaction and child work. Existing `packages/claxedo-server-core/src/usage/contracts.ts:9` already distinguishes provider observation identity and settlement quality, and `usage.sql.ts:28` stores revisions separately from current facts. Preserve those semantics. Record provider attempts with stable identity and purpose, then define their aggregation into session/message totals; missing final usage stays unavailable/partial. Also explicitly resolve the current required `harness` field and location union for harness-less work sessions rather than inventing a harness value.

**8. [P2] The maintenance and cost tables are estimates, not established simplification.**

The listed new code already totals roughly 5,000 lines before transport, plugin integration and wakes, against roughly 6,000 proposed deletions. The meaningful simplification is removal of a placement axis and bespoke harness internals. Claxedo still gains an agent product, snapshot ownership protocol, gateway and upstream upgrade burden. Treat the 1,500-line subclass ceiling as a hypothesis, and measure maintained production code separately from tests, migrations and generated code after the spike.

Hibernation removes eligible object duration charges, not all storage/request costs. Active duration is wall-clock time, including relevant waiting, not CPU time alone; the monthly estimate therefore needs an assumed active duration per turn. Official pricing also rounds billable excess to billing units, so a marginal hourly calculation is not an invoice forecast. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Container CPU is charged for actual active usage while provisioned memory/disk are charged separately. The standard-1 estimate of about $0.074/hour assumes its allocated CPU is continuously used; half an hour at that rate is about $0.037, outside the table's stated $0.07–$0.11 range. Label machine size, utilization, allowances and exclusions. [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

**Recommended next slice.** Keep the two session kinds and native Pi adapter. Amend the above contracts, then use Unit 1 to prove one API-key model, one private repository and one machine child, including the admission-crash and snapshot-import-crash cases. Pin the complete Think/Agents/shell dependency set used by that proof. Complete the autonomous authorization and approval path before scheduling production work. Remove central only with its consumer cutover. If facets are unavailable, report that capability as unavailable unless policy explicitly authorizes a machine child; do not make a supposedly bootless subagent silently lease compute.

**Verification performed.** `cmp` confirmed the supplied attachment matches the repository plan. `git rev-parse --short HEAD`, targeted `rg`, and `sed` traced the channel consumers, SDK exports, usage contracts, and published Think source/documentation. The exact npm package was inspected in `/tmp/claxedo-think-review-017` without installing it into the repository. Official Anthropic and Cloudflare documentation was checked live. No application tests, Miniflare execution, staging deployment, native binary proof or dependency compatibility build was run; those acceptance criteria remain unverified. The plan and production code were not edited by this review.
