# All-harness sharing and Pi plan: Opus 5.5 adversarial review

Date: 2026-10-03 (Asia/Kolkata)

Reviewed plan: [Pi Durable / Boat and all-harness implementation plan](../architecture/pi-durable-boat-hld.md).

## Decision after verification

Baseline measurement and bounded feasibility work can start. Correct the restart, authorization, migration and shared-resource contracts before implementing the affected paths. The review does not establish that the overall architecture must be replaced.

Claude returned **10 candidates: five P1, four P2 and one speculative P3**. The full response is preserved below. The dispositions in this section distinguish actionable gaps from claims that are broader than their evidence or already addressed by the plan. They take precedence over treating every reviewer recommendation as an accepted requirement. This review changes neither the plan nor production code.

## Verified dispositions

| Finding | Disposition | Required decision or correction |
|---|---|---|
| CLX-01: field Pi migration | Retain P1; narrow the claim | W10 already requires explicit blocking reasons and a product decision. Specify how an RPC-free shipped build handles an incompatible field profile, an upgrade with an older process still alive, owner-login credential migration and downgrade. Preserve readable history and required resources. User acknowledgment to omit resources is a reviewer suggestion, not an approved relaxation. |
| CLX-02: local restart authority | Retain P1 | A relay-admitted local turn needs an authenticated continuation contract after daemon restart, or an explicit authorization-required hold. Persisted actor identity alone is not proof, and recovery must not silently become a loopback-owner request. |
| CLX-03: worker and store ownership | Retain P1; correct the acceptance test | Specify behavior on daemon-link loss, uncertain mutation handling and exclusive ownership before reopening a root store. Existing detached launch infrastructure makes orphaned execution possible; the proposed Pi worker has not been implemented or reproduced. |
| CLX-04: shared-VM credentials | Retain as a conditional P1 trust-contract gap | Separate session routing from protection against another principal executing arbitrary code in the same OS trust domain. Define which credentials may enter that domain, or prove an isolation mechanism. The review did not establish a current cross-member exploit through canonical workspace admission. |
| CLX-05: memory outcome | Retain as P2 measurement and sequencing work | Predeclare matched workloads and an outcome decision rule; measure gate/payload retention and evaluate an early safe Codex release slice. The historical RSS sample does not establish idle sessions or causal attribution. Idle release must not replace the user's concurrent-sharing requirement. |
| CLX-06: indefinite VM retention | Product-policy option; not a missing correctness mechanism | The plan already has authorized stop/recovery for unresolved execution. A spending cap or unattended containment policy would require explicit authorization and whole-workspace semantics. Do not automatically archive because an acknowledgment or heartbeat is missing. |
| CLX-07: host launch versus workspace gate | Retain P2 | Join unresolved host-owned launches to durable workspace memberships when admitting mutations. Affected workspaces retain the existing 503 refusal; unrelated workspaces remain available. |
| CLX-08: local/cloud dependency graph | Retain P2 | Establish the canonical local Node executor early, split local recovery from DO recovery and draw explicit local/cloud release paths. The plan already permits local release; the graph and ownership assignments need to implement that policy clearly. |
| CLX-09: Pi worker decision | Retain P2 decision-record work | Compare daemon embedding with a separate worker; specify actual process-global settings and extension trust restrictions. Do not add account partitions without establishing why they are necessary, or treat same-owner roots as safe for arbitrary untrusted extensions. |
| CLX-10: atomic DO projection | Research question only | Sharing a database does not prove Pi commit hooks, transaction compatibility or projection atomicity. Keep the canonical projection/recovery contract until an actual integration proves it can be simplified. |

### Concrete failure paths and acceptance changes

**1. Local prompt through relay → daemon restart → authorization gap.** The existing managed branch requires both `managed-private` composition and `relay-replayed` request provenance. Its CP turn lease renews through in-memory timers. Existing deferred grants cover only `child_completion` and `queued_prompt`; they do not authorize continuing the interrupted active turn. A persisted actor field cannot substitute for an authenticated grant. Current lease loss has the error `Durable session turn lease was lost`; the proposed recovery refusal/error contract still needs definition. Test restart during an active turn and approval wait, with the sender revoked during downtime. No new dispatch may occur without current authorization. Sources: [managed branch](../../packages/session-core/src/routes/session-route-options.ts), [lease lifecycle](../../packages/session-core/src/routes/session-turn-lease.ts), [admission](../../packages/session-core/src/routes/session-prompt-admission.ts), [grant intent validation](../../packages/claxedo-server/src/session/deferred-turn-grant.ts).

**2. Daemon dies → detached worker may survive → unsafe continuation or second store writer.** The launch gate deliberately creates a detached POSIX process group and documents that its payload can continue after the parent disappears. Pi's storage contract assumes one owning process. Fencing callbacks does not stop the previous scheduler or writer. Require a bounded loss-of-supervisor response, no new dispatch after that response/deadline, durable holds for uncertain effects, and verified prior-owner retirement before opening a replacement writer. Retain necessary reconciliation writes and late observations. Claude's proposed test demanding zero effects or commits after link loss is too strong: an already-dispatched external operation may still complete. Embedding removes the separate Pi worker failure boundary, but cannot revoke already-dispatched external work. Sources: [launch gate](../../packages/process-ownership/src/launch/launch-gate.ts), [gate child](../../packages/process-ownership/src/launch/launch-gate-child.ts), [Pi v1.0.0 storage documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md).

**3. Shared launch moves to host scope → workspace-only reconciliation misses it.** Today `workspace/durable-state.ts` reconciles the supplied launch-owner scope and rejects mutation admission with **503 `workspace_launch_unreconciled`** while that reconciliation has unresolved launches. W03 moves some ownership to host scope. Its general reconciliation requirement must explicitly include membership-aware admission: an unresolved shared process serving A and B blocks both, while C remains usable. This is a proposed integration hazard, not a demonstrated bug in a host-sharing implementation that does not yet exist. Source: [workspace durable state](../../packages/workspace-runtime/src/workspace/durable-state.ts).

**4. RPC-free upgrade → incompatible field profile.** W10 already calls for resource inventory, truthful migration errors and blocking active/uncertain work. What remains is the installed-product contract when compatibility is discovered after the executable has been removed. Make owner-login OAuth/refresh ownership, imported JSONL, extension commands/dialogs and executable overrides explicit qualification cases. Absence of an OAuth or importer example in the Pi README does not prove lack of support. Downgrade divergence is a risk to test, not an observed failure. Preserve the decision to replace RPC and keep the public name `Pi`; a retained automatic fallback is not an accepted remedy.

**5. Per-session MCP credentials → code execution in one shared VM.** Session-bound handles and catalogs can prevent misrouting without creating an OS security boundary. The plan already admits this limitation and rejects unsupported never-readable-secret modes. Add the missing credential-admission rule for the actual workspace execution trust domain, plus an adversarial sibling/terminal read test where distinct principals are admitted. Shared organization roles and multi-person credential fixtures alone do not prove that every organization member may execute in the same workspace. Neither a confirmed exploit nor universal failure of session-scoped MCP was established.

### Corrections to broader reviewer claims

- **Local release is already permitted.** Plan line 819 explicitly allows local Pi release while cloud feasibility remains open. CLX-01/08 therefore identify inconsistent work-unit ownership/dependencies, not an absent local-release policy. Move `workspace-execution` ownership early and separate the recovery/release subsets.
- **Uncertain execution already has an authorized stop path.** Plan lines 504–506 retain ownership until reconciliation or authorized recovery. Disabling Boat's TTL permits retention; it does not authorize an automatic stop. Confirmed archival stops guest execution but does not undo or resolve already-triggered external side effects. Any preauthorized spending policy must account for every root using the workspace. [Boat lifecycle documentation](https://docs.boat.dev/long-running-tasks).
- **The memory cause remains unproven.** Source inspection supports retained attached Codex processes and resident gates. The old sample did not record active/quiescent state, and summed RSS is not unique physical memory. An early release experiment is useful, but removing W02 dependencies is conditional on preserving the canonical configuration and authority contracts. Keep concurrent sharing as a separate acceptance requirement.
- **The plan already limits global-mutating extensions.** L7 explicitly refuses to declare them isolated. CLX-09 should turn that into a precise compatibility/trust contract, not claim the plan entirely missed the issue. A finite test of an extension cannot prove arbitrary same-heap code isolation.
- **Projection simplification is unproven.** Pi's documented asynchronous storage facade and the DO database's transaction API require a concrete proof. Being colocated in a process or database does not itself remove event projection and recovery obligations.

## Coverage and evidence limits

All six requested harness families were considered: Codex, Cursor, OpenCode2 V2, Pi, Claude and ACP. Depth was uneven: the strongest direct-source findings concern Pi, Codex, daemon launch ownership and relay authorization. Cursor and ACP received less independent native-protocol verification; their qualification gates remain open. The name `opencode-sdk` in repository paths refers to the current embedded V2 integration, not a finding based on old OpenCode server documentation.

Independent resolution of `packages/harness/node_modules/@opencode-ai/sdk/package.json` found `0.0.0-beta-19271`. The workspace-runtime package resolves a different installed version (`0.0.0-beta-18684`); it was not used as the harness's authoritative SDK version. This verifies dependency selection, not V2 descendant ownership or live behavior. Claude could not verify the installed SDK's descendant behavior.

This was a source and plan review. No application tests, packaged client flows, real-provider runs, memory benchmarks or deployments were performed. Pi Durable compatibility, storage integration, scheduler holds and cloud feasibility remain implementation gates. Source conclusions are not production reproduction claims.

## Reviewer provenance

- Actual CLI: `/Users/yashvardhansingh/.local/bin/claude`, version `2.1.287 (Claude Code)`.
- Requested reviewer: `claude-opus-5-5`, `--effort high`. All 128 reviewer assistant messages in the stream identify `claude-opus-5-5`.
- Completion: exit 0, `subtype: success`, `is_error: false`, approximately 19 minutes. No tool permission denials; no subagents spawned.
- The CLI also reports auxiliary `claude-haiku-4-5-20251001` usage for its WebFetch summaries. The reviewer remained Opus; fetched source summaries were not exclusively produced by Opus.
- Allowed tools: Read, Glob, Grep, WebFetch and WebSearch. Actual review used Read 28 times, Glob 10, Grep 34 and WebFetch 6. Bash, Edit, Write and Agent were unavailable.
- Session: `146365bb-00da-498d-b551-d45d8f89434b`.
- The initial sandbox attempt could not access the existing Claude login and performed no review. The successful invocation used the existing authenticated CLI outside that sandbox after tool approval.
- Branch `dev`; HEAD before/after `ac60269b8ade713361b884850c22e48dc278353e`. The three input-document hashes below were unchanged after the review. Concurrent unrelated dirty files were preserved; they are not claimed as reviewed or changed by this task.
- Local run artifacts: `/private/tmp/claxedo-all-harness-opus-5-5-adversarial-20261003/` (`prompt.txt`, `events.jsonl`, `result.json`, `claude-review.md`, input snapshots and provenance). This report preserves the returned review independently of those temporary files.

Invocation, with the read-only review prompt supplied on stdin:

```sh
claude -p --model claude-opus-5-5 --effort high \
  --output-format stream-json --verbose --safe-mode --strict-mcp-config \
  --disable-slash-commands --no-chrome --no-session-persistence \
  --permission-mode dontAsk --permission-prompts none \
  --tools Read,Glob,Grep,WebFetch,WebSearch \
  --allowedTools Read,Glob,Grep,WebFetch,WebSearch
```

| Input | SHA-256 |
|---|---|
| `docs/architecture/pi-durable-boat-hld.md` | `4b3a62662ddaf96c9c86aaf7c80eb43a9a93c988347b271fb996d8fc96d2ade3` |
| `docs/architecture/2026-10-03-claxedo-session-execution.md` | `2f30325fcebb3b821d29488805ee0ff8a75546416039596ebbebe109f5eb2fd9` |
| `docs/architecture/2026-10-03-harness-failure-matrix.md` | `2d44eab6ab2ac6c7b83de899c20d4f470a88b7375c811b0f52c8c8a1992720d4` |

## Artifact verification

- An inline `python3` check passed: the report ends with the exact returned reviewer text; CLX-01 through CLX-10 each occur once as finding headings; all eight local Markdown links resolve; all three input hashes match the starting snapshot; all 128 reviewer messages identify the requested model.
- `git diff --no-index --check /dev/null docs/reviews/2026-10-03-harness-sharing-pi-opus-5-5-adversarial-review.md` produced no whitespace diagnostics (exit 1 from the no-index comparison of a new file).
- `git rev-parse HEAD` remained `ac60269b8ade713361b884850c22e48dc278353e`. Only this new report was written by the review task; the plan and production files were not edited.
- Application tests and architecture ratchets were not run: this task adds review documentation and changes no production imports.

## Full Claude response — retained as reviewer output

The response below is verbatim reviewer text. Its severities, recommendations and quoted source excerpts are attributed to Claude, not blanket acceptance by the verification pass above. Claude notes that fetched excerpts may be lightly paraphrased by its fetch summarizer. File references in this response are repository-relative; colon-only plan references refer to the reviewed architecture plan.

---

# Adversarial review: Claxedo harness sharing and Pi Durable plan

**Primary authority:** `docs/architecture/pi-durable-boat-hld.md`, read in full (lines 1–988, W01–W20, H1–H7, L1–L11, A1–A16)
**Evidence companions:** `2026-10-03-claxedo-session-execution.md` and `2026-10-03-harness-failure-matrix.md`
**Reviewer:** claude-opus-5-5, high effort. Read-only source and documentation review. I did not open the earlier review.

---

## 1. Verdict

**Starting W01 and other independent work: GO, with conditions.** W01 has no code dependencies, and its proofs are mostly real gates. Before it starts, three changes are needed:

1. Split W01 into separate units: a native baseline/census unit, a local-Pi feasibility unit, and the cloud gates G1–G4.
2. Add a local-Pi gate with decisive pass/fail properties for:
   - worker link loss;
   - single-writer ownership of the Pi store;
   - authority for relay-admitted turns after a restart;
   - owner-login credential parity (CLX-01/02/03).
3. Detach Codex sharing and quiescent release from W02 (CLX-05).

The following can start safely now: W01 native baseline, W03 design (with CLX-07 included), the W04 Codex process router, W05, W11 qualification, and W12's design of the D1 row-preserving upgrade.

**Full implementation and release: NOT READY.** Five P1 decisions are unresolved:

- **CLX-01:** What happens in the field to existing Pi profiles that can't be migrated once RPC is deleted.
- **CLX-02:** How a local turn admitted through the relay keeps its authority after a restart.
- **CLX-03:** What a local Pi worker does when its daemon dies, and who owns the Pi store.
- **CLX-04:** Whether credentials placed inside a shared Boat VM can really be session-scoped.
- **CLX-05:** The memory problem that triggered this work is not on the critical path, and success can't be falsified.

Writing more code does not resolve any of these; each needs a decision.

---

## 2. Findings

### CLX-01 — P1 — Deleting RPC is decided once at build time, but Pi compatibility is only known per profile on users' machines — Confidence: high

**Plan references**
- `pi-durable-boat-hld.md:33` — "There is no retained installed-SDK execution path or automatic RPC fallback."
- `:43` (N5) — "Inventory existing user profiles/extensions and port or explicitly resolve incompatible behavior before cutover."
- `:329` — direct Node extensions are "not redirected"; "retaining RPC… is not the target."
- `:719–722` (W10) — "If required import or resource parity cannot be established, the affected cutover remains blocked… W20 removes RPC only after these criteria pass."
- `:813` (W20) and `:898` (H4).
- `:851` — W20 depends on W19, which depends on every cloud row A1–A16.

**Source evidence**
- `packages/harness/src/profiles/pi/index.ts:38–46`: owner-login sessions run on the user's own `~/.pi/agent` (`ownerAgentDir`). `:29` probes `auth.json`, `models.json` and `settings.json`, plus the profile's `extensions` directory. `piProbeInputs` (`:78–83`) adds project `.pi/extensions`.
- `packages/harness/src/transports/pi-rpc/extension.ts:23–30` and `pi-rpc/README.md:15`: Claxedo today surfaces the user's extension commands, prompt templates and skills through `get_commands`. `pi-rpc/index.ts:67` advertises `questions: true`, which comes from extension UI dialogs (`README.md:5`).
- `packages/harness/src/transports/pi-rpc/launch.ts:118–127`: resume locates the RPC session's JSONL file by upstream ID.
- Pi Durable README (pinned v1.0.0):
  - extensions use `defineExtension()`; nothing is documented about compatibility with coding-agent CLI extensions;
  - providers read credentials from the environment (`openaiProvider() // reads OPENAI_API_KEY`);
  - no import from coding-agent JSONL is documented.
- Pi Durable is not yet in `bun.lock`.

**Trigger and failure sequence**
1. A user's default local profile is owner-login and has either a third-party extension in `~/.pi/agent/extensions`, a repo `.pi/extensions`, or OAuth credentials in `auth.json`.
2. W10's inventory runs as a developer activity, on fixtures. It cannot enumerate field profiles, because they exist only on users' machines and in their repos.
3. W20 ships a build without RPC once the tests pass.
4. On first launch, that user's profile fails the compatibility check. The plan says the cutover "remains blocked," but no RPC exists in the build to keep the session running. The user effectively loses Pi execution. What they see depends on an error that W10 hasn't defined yet. If the profile's state is not checked at all, extension commands or dialogs disappear silently, which N5 forbids.
5. Downgrade risk (inference): W10 keeps the source records until migration commits. If they survive the commit and the upstream ID is unchanged, an older build resumes the stale JSONL with no error, diverging from the canonical transcript. If they're deleted, the older build fails with `Pi session <id> has had turns, but its session file is gone from <dir>` (`launch.ts:126`).
6. A session that was active when the user upgraded can't be quiesced by RPC code that no longer ships.

**What the plan already says, and why it isn't enough.** W10 blocks cutover per profile and forbids hidden legacy modes. That is correct for each session. But the plan never says what the shipped product does for blocked profiles once W20 has deleted the only executor that understands them. "Blocked cutover" and "RPC absent" can't both hold in the field. In addition, W20's dependency on every cloud row means the local cutover can't finish until the Boat/DO work passes.

**Smallest decision needed (user/product owner)**
- (a) Define the field outcome for an incompatible profile in an RPC-free build. I recommend: history stays readable; execution is refused with an enumerated list of blocking resources; and a per-profile, explicit, recorded acknowledgment lets the user continue without them. That avoids both silent loss and a fallback.
- (b) Make the JSONL importer independent of RPC code. Retire any RPC process left from before the upgrade through launch ownership and mark it interrupted.
- (c) After commit, archive or rename the source JSONL so that older builds fail truthfully instead of resuming stale history, or explicitly declare downgrade unsupported.
- (d) Make owner-login OAuth (`auth.json`, including refresh-token ownership shared with the user's own Pi CLI) an explicit W01 gate.
- (e) Release the local Pi cutover separately from the cloud rows.

**Affected units:** W01, W10, W16, W20.

**Acceptance check:** extend H4. Upgrade three populated profiles, each with one of: a third-party extension command, owner-login OAuth, a project `.pi/extensions`. Check:
- the refusal or acknowledgment flow is truthful;
- zero RPC processes spawn;
- no command, dialog or credential is silently dropped;
- an older build behaves as declared.

**Evidence status:** current behavior is source-confirmed. Durable's lack of CLI-extension compatibility and OAuth support is unverified upstream: the README is silent, which is not proof either way.

---

### CLX-02 — P1 — A local Pi Durable turn admitted through the relay has no authorization path to resume after a restart — Confidence: high

**Plan references**
- `:57` (R5) — "CP rechecks the original actor's current access."
- `:60` (R8) — "Local worker/daemon restarts… resume supported work."
- `:413–421` — the `cp-session-host` proof is defined only for the DO.
- `:701` (W08) — "Preserve existing local/managed authorization branches."
- `:738` (W12) — "existing workspace-hosted placements retain their appropriate admission/lease branch."
- `:766` (W15) — "Reauthorize… before scheduler dispatch."
- `:905` (L4).

**Source evidence**
- `session-core/src/routes/session-route-options.ts:218–221`: a managed lifecycle means managed-private authority *and* `relay-replayed` provenance.
- `session-core/src/routes/session-turn-lease.ts:83–178`: renewal and expiry run on in-process timers; losing the lease aborts the turn with `Durable session turn lease was lost` (`:108`).
- `session-core/src/routes/session-prompt-admission.ts:138–153`: "the actor it was recorded under is a claim the plane refuses as proof." Grants are minted only for relay-replayed requests.
- `claxedo-server/src/session/deferred-turn-grant.ts:150`: the only grant intents are `child_completion` and `queued_prompt`.

**Trigger and failure sequence**
1. A signed remote client or shared-session sender prompts a local Pi session through the relay. Session-core acquires a CP lease using the request's `relayHostAuth`.
2. The daemon crashes or restarts mid-turn, or during an approval wait. The lease and its timers disappear.
3. On restart, W15 has to "reauthorize the recorded admission." There is no request context, CP refuses the stored actor as proof, and no grant intent exists for resuming after a restart.
4. The implementer is left with two options:
   - resume without CP proof. This silently bypasses R5 (for example, an actor revoked during the downtime keeps executing). No exception is expected.
   - fail to resume, which contradicts R8 and L4.

**What the plan already says, and why it isn't enough.** The DO receives a fully specified continuing-authorization contract (`:413–421`) and gate G3. The local placement is told only to keep its existing branch, and that branch provably can't resume. G3 doesn't cover local placement.

**Smallest correction (choose one)**
- (a) Declare that a relay-admitted local turn interrupted by a restart parks as "authorization required" until a fresh authorized action, while loopback-owner turns resume automatically. This is truthful and small.
- (b) Add a CP grant intent for resuming a specific turn, minted at admission, short-lived, and rechecking the actor's current access when redeemed.

**Affected units:** W01 (add to G3), W08, W12, W15.

**Acceptance check:** an L4 variant with a relay-admitted turn: kill the daemon mid-turn, revoke the sender during the downtime, then restart. Either zero dispatches occur and the state shows "authorization required", or the grant is redeemed and the revocation is honored. The approval-wait version must give the same result.

**Evidence status:** source-confirmed.

---

### CLX-03 — P1 — The local Pi worker can outlive its daemon and keep running; store single-writer ownership is never stated — Confidence: medium-high

**Plan references**
- `:25`; `:227–230`.
- `:305` — "Pi calls the typed local execution adapter directly where colocated or through local IPC."
- `:307` — "After a worker/daemon restart, reopen each root's original store."
- `:539`.
- `:701` (W08) — "Fence old worker callbacks before resuming original roots."
- `:905` (L4).

**Source evidence**
- `process-ownership/src/launch/launch-gate.ts:55–66`: every owned launch spawns a `detached` gate (`:64`).
- `launch-gate-child.ts:45–48`: the gate ignores `SIGTERM`, `SIGINT` and `SIGHUP` and stays resident as the group leader.
- `workspace-runtime/src/spawn-service.ts:10` routes every harness spawn through it.
- Pi Durable README:
  - "One process owns a storage at a time; there is no cross-process locking."
  - "A throw becomes an error result."
  - `resume()` "starts the task scheduler."

**Trigger and failure sequence**
1. The daemon is killed mid-turn. The gated Pi worker sits in its own session and process group, so it isn't signalled. Whether the payload exits depends on how the worker is implemented; the plan doesn't require it to exit.
2. Pi's scheduler keeps running. With owner-login, model calls still succeed because the credentials are in the profile.
3. Tool calls to the IPC executor in the daemon throw. Pi turns each throw into an error result, so the model can retry the same mutation under a new tool ID. That is exactly R10's hazard, reached without any loop restart. If the executor runs "colocated" in the worker, file mutations continue with no daemon journal and no lease.
4. The restarted daemon has to project entries that were committed with no authority. If it reopens a root store while the old worker is alive or unverified, two processes write to one store that has no cross-process locking. No exception is expected; the result is silent divergence.

**What the plan already says, and why it isn't enough**
- W08 fences *callbacks*, which doesn't fence a live writer or a live scheduler.
- W03's "failed retirement blocks unsafe replacement" stops a replacement *launch*. It doesn't stop the surviving worker from executing, and it doesn't tie reopening the store to verified retirement.
- G1 is about workerd only.

**Smallest correction**
- (1) The worker holds a liveness link to its supervisor. When the link is lost, it parks: no new model or tool dispatch, it records the interruption, then exits.
- (2) A transport failure on a mutating typed operation becomes a durable hold, never a tool error result.
- (3) A root store may be reopened only after the previous owning process's retirement is verified, with an owner-generation fence in the store.

Alternatively, choose daemon-embedded execution (CLX-09), which removes this whole failure class.

**Affected units:** W01 (local gate), W03, W07, W08, W15.

**Acceptance check:** run a fake provider that counts requests, plus an effect counter. `kill -9` the daemon mid-turn, both while a mutation is in flight and while one is pending. Expect zero provider requests, effects or commits after link loss. A restart while the old worker's retirement is unresolved must refuse to open the store.

**Evidence status:**
- Source-confirmed: gate detachment and residency.
- Upstream README: the single-writer rule and throw-to-error-result behavior.
- Inference: the worker's behavior when its link drops, since it isn't written yet.

---

### CLX-04 — P1 — Credentials placed inside a shared Boat VM can't be scoped to a session; A16 asserts something that can't be delivered — Confidence: high (exposure) / medium (how common multi-owner workspaces are)

**Plan references**
- `:57` — "The stored session owner's account remains the spending account."
- `:322` — stdio MCP: "Scope cwd/env/secrets to the approved server and session."
- `:339`.
- `:490–492` — workspace-level terminals.
- `:588`.
- `:610` — "not isolation from hostile code inside a shared VM."
- `:709–711` (W09).
- `:933` (A16) — "Two DO sessions use different… stdio MCP servers and credentials on the same VM… stay scoped."

**Source evidence**
- `agent-runtime-contract/src/credential-snapshot.test.ts:4–10`: one runtime holds several people's credential bindings by design.
- `claxedo-server/src/authority/adapters/d1/workspace-authority.ts:110–115`: orgs can be `shared`, with `member`, `admin` and `owner` roles.
- `session-authority.ts:126`: sessions record a `creator_actor_id` separate from the workspace owner.
- Boat platform guide: `noEnv` protects the *account*. Nothing is documented about process-level isolation inside a sandbox.

**Trigger and failure sequence**
1. In a shared-org cloud workspace, member X's Pi session starts a stdio MCP server in the guest with X's token in its environment.
2. Member Y's session, which runs in the same VM, executes `ps eww`, reads `/proc/<pid>/environ`, or reads the bridge's config files. So can any member who opens a workspace-level terminal (`:490`).
3. Y obtains X's credential. No exception is expected.
4. Revoking X's grant afterwards doesn't take back a secret that has already been copied.

**What the plan already says, and why it isn't enough.** `:610` concedes there is no isolation inside the VM, and `:588` refuses never-readable secrets. But readable per-session secrets are still promised as "session-scoped," and A16 would pass a test that never tries a sibling read. The same exposure already exists in today's native VMs, so the plan can't claim new scoping without a mechanism.

**Smallest decision needed**
- Declare the guest a workspace-wide trust domain.
- Admit secret-bearing stdio MCP into the guest only when every principal who can execute in that workspace is entitled to the credential, for example a single-owner workspace or a workspace-shared connection. Otherwise refuse it as an explicit unsupported mode.
- Or add a gate that proves per-owner OS-user isolation in the guest (process and `/proc` visibility, file permissions, terminal user).

**Affected units:** W01 (G3/G4), W09, W13, W17, A16.

**Acceptance check:** extend A16 with adversarial reads from a session owned by a different account and from a workspace terminal. Either the reads find nothing, or credential admission refuses the configuration.

**Evidence status:** source-confirmed for multiple owners per workspace and runtime. The exposure itself is inference from OS semantics and is not disputed by `:610`.

---

### CLX-05 — P1 — The evidenced memory problem isn't on the critical path, and the plan's measure of success can't be falsified — Confidence: high

**Plan references**
- `:45` (N7) and `:804` — "not… a percentage-savings gate."
- `:645` — W02 depends on W01.
- `:663` — W04 depends on W01–W03.
- `:792–796` — W18 idle release comes after W04–W11, and the graph adds W15 and W17 at `:845–849`.
- Audit `:263–265` — 10 Codex wrappers (about 378 MiB summed RSS) plus 10 app-servers (about 700 MiB), all in one workspace, with their state unrecorded.

**Source evidence**
- `session-core/src/host/sessions.ts:288–292` and `codex-app-server/sessions.ts:100–111`: an attached Codex root keeps its process until the session is deleted, handed off, or the workspace is disposed. Nothing releases it when quiescent; a search for quiescent or idle release in session-core and workspace-runtime found none.
- `launch-gate-child.ts:45–52`: every launch keeps a resident gate process.
- `claxedo-desktop/src/main/server-child-process.ts:13–18`: the daemon runs as Electron-as-Node, and `launch-gate.ts:55` spawns gates with `process.execPath`.

**Trigger and failure sequence**
1. The likely real cause is idle attached roots: N sessions × (app-server + gate), retained indefinitely.
2. The cheapest fix is quiescent release of Codex roots. Codex already supports `thread/resume`, and the failure matrix's CX2 condition defines when release is safe. That fix doesn't need W02's per-session capability feature or cross-workspace pooling.
3. The plan routes it through W02, W03 and W04, then W18 at the end of the graph.
4. All 20 units can pass N7 and W19 with no reduction in memory, because success is defined as attribution, not outcome.
5. Gate residency, which accounts for roughly a third of the sampled RSS and persists for unshared Claude and ACP launches, has no unit addressing it.

**What the plan already says, and why it isn't enough.** W18 does contain idle release, and N7 rightly rejects summing RSS. But the plan's ordering and acceptance rules allow "complete" with the user's actual problem unsolved.

**Smallest correction**
- Add an early slice for Codex quiescent release and process census, depending only on the W01 native baseline.
- Make W04 depend on W03 alone, with W02 integration later.
- Add a pre-declared comparison decision rule, not a percentage target: report the recorded workload's physical footprint before and after the change; if there is no reduction, require an explanation and a decision.
- Decide explicitly whether gate residency is in scope.

**Affected units:** W01, W04, W18, W19.

**Acceptance check:** for 10 Codex sessions in one workspace, after the work goes quiescent the process census shows released app-servers and gates, and the next prompt resumes the same thread.

**Evidence status:** source-confirmed.

---

### CLX-06 — P2 — An unresolved command outcome pins a paid VM indefinitely, and the untrusted guest can trigger it — Confidence: medium-high

**Plan references**
- `:66` (R11).
- `:502–506` — "An unknown outcome has an owner-visible recovery path, not an automatic deadline…"; the provider TTL is disabled.
- `:518–527` — `NeedsAttention` reaches `Archived` only via "Saved stop confirmed".
- `:590` — the guest is untrusted.

**External evidence**
- Boat long-running-tasks documentation: TTL is set with `ttlSeconds: null`; "Detached processes do not survive a stop, resume, or fork on their own."
- Boat platform guide: "Hand-run processes do not [survive stop and resume]."

**Trigger and failure sequence**
1. A command's acknowledgement is lost, or guest code makes the status API hang.
2. The workspace enters `NeedsAttention`, and idle archival is blocked.
3. The owner never returns. The VM bills indefinitely.

A shared-session sender, or a malicious repository, can cause this deliberately.

**What the plan already says, and why it isn't enough.** It correctly refuses to declare the effect resolved. But a confirmed archive is itself proof that guest processes have stopped. It resolves "is this still running?" without claiming anything about "did the effect happen?", so it is a legitimate way to contain the uncertainty that the state diagram doesn't include.

**Smallest correction:** add an authorized, policy-bounded "contain by archive" transition:
- notify the owner first;
- record each unresolved operation as `terminated by archive; effects unknown`;
- never redispatch.

Count guest-induced unknowns toward the bound.

**Affected units:** W13, W15, A6, A9.

**Acceptance check:** lose an acknowledgement and abandon the session. When the bound passes, the VM is archived, the operation shows unknown effects, and the effect counter is unchanged. A guest that never acknowledges can't extend the VM's lifetime.

**Evidence status:** plan text plus Boat documentation. The billing impact is inference.

---

### CLX-07 — P2 — Shared launches recorded at host scope escape the per-workspace mutation gate (SH2) — Confidence: medium

**Plan references:** `:655–658` (W03), "workspace reconciler cannot signal another owner's launch; failed retirement blocks unsafe replacement"; failure matrix SH2 `:130`.

**Source evidence**
- `workspace-runtime/src/workspace/durable-state.ts:74–86`: the gate answers 503 `workspace_launch_unreconciled` only for unresolved launches in that workspace's own scope.
- `workspace/runtime.ts:154` sets that scope to `{ kind: "workspace" }`.
- `ownership-store.ts:18–27` lists only workspace and standalone scopes.

**Trigger and failure sequence**
1. The daemon crashes while a shared Codex process P, recorded at host scope, is running a turn for A1.
2. Because P's gate is detached, P can survive.
3. On restart, retiring P stays unresolved.
4. Workspace A mounts. Its gate lists no workspace-scoped rows and admits a mutation.
5. A new process starts in A's checkout while P may still be mutating it. SH2 is silently bypassed; no error appears.

**Smallest correction:** an unresolved host launch with recorded memberships must hold the mutation gate in every member workspace, using the existing `workspace_launch_unreconciled`, and only those workspaces.

**Affected units:** W03, W18.

**Acceptance check:** make P's retirement unresolved. Mutations in A and B return 503, while workspace C, which had no members in P, admits.

**Evidence status:** gate scope is source-confirmed; the plan omission is inference.

---

### CLX-08 — P2 — Local Pi depends on owners that only exist after cloud units; the graph contradicts the local-release claim — Confidence: high

**Plan references**
- `:709` — W09 puts its Node MCP adapters in the Node MCP adapter proposed in the `workspace-execution` package.
- `:784` — that package's `package.json` is created only in W17.
- `:785` — W17 is where "One implementation owns Node execution mechanics… The local adapter may call it directly."
- `:701` — W08 "Inject typed local file/process operations" names no owner.
- Graph `:839–844`: W13 → W15, W14 → W15, W15 → W16 → W17.
- `:819` — "local Pi Durable can pass its local release gate while cloud feasibility remains open."
- `:764` — W15's text says local recovery doesn't wait for the cloud, but the graph edges do.

**Failure sequence:** the local typed executor and the local stdio MCP adapter have no canonical owner until a unit that transitively depends on W13–W16 (Boat, DO, CP routes). The implementers must either build a temporary duplicate executor, which AGENTS.md's "one implementation per responsibility" forbids, or block local Pi on the cloud work.

**Smallest correction**
- Create `workspace-execution` (Node mechanics, local adapter, stdio MCP) as an early unit depending on W01/W02 only.
- Narrow W17 to the guest composition.
- Split W15 into a local unit (depending on W07/W08) and a DO unit.
- Draw separate subgraphs for local release and cloud release.

**Affected units:** W08, W09, W15, W17, W20.

**Acceptance check:** the set of local-release units has no transitive dependency on W12–W14 or W16.

**Evidence status:** source-confirmed in the plan text.

---

### CLX-09 — P2 — Running the local Pi worker as a separate process is never weighed against embedding it in the daemon, and its compatibility/trust key is undefined — Confidence: medium

**Plan references**
- `:191` — compatibility covers "account scope where process-global… extension generation and trust policy."
- `:303`; `:323`.
- `:236`; `:911` (L10).
- `:595–606` — the alternatives table covers cloud only.
- Failure matrix PI7 `:105` — the only stated risk of embedding.

**Source evidence**
- The daemon is Electron-as-Node (`server-child-process.ts:13–18`).
- OpenCode2 already embeds per-workspace engines in it.
- A separate worker adds a runtime process, a resident gate, IPC for every file operation, and the CLX-03 failure class.
- The Pi README's single-process store ownership would be satisfied trivially if Pi ran in the daemon.

**Gap**
- The worker's benefit, isolating faults in extension code, depends on what extension code is admitted. Yet the plan already restricts that code to managed extensions with declared hooks (`:320`).
- Nothing says what is process-global in Pi Durable:
  - environment-based providers;
  - `process.cwd` and `process.env` used by extensions;
  - the module cache.
- Per-root objects in one JS heap are not a credential boundary once non-first-party or repo `.pi/extensions` code loads. Roots belonging to different owners can co-reside: for example shared-org members on an enrolled host, which the multi-person credential snapshots show is a designed case.

**Smallest correction**
- Record the decision, with W01 measurements comparing an embedded root against 1 and N worker roots.
- Define the Pi compatibility key as {Durable build, spending owner, extension code set and trust class}.
- Co-locate roots in one heap only when no non-first-party code is loaded, or when every root shares the same owner and trust class.

**Affected units:** W01, W03, W08, L10.

**Acceptance check:** with roots from two owners and an extension that walks in-process state, neither can observe the other's credential. The measured embedded-versus-worker figures are recorded.

**Evidence status:** inference grounded in source and upstream documentation.

---

### CLX-10 — P3 — In the DO, both stores share one SQLite database, so the cross-store projection machinery may be unnecessary there — Confidence: low-medium

**Plan references:** `:540–541`; `:544` "Do not assume atomic transactions span Pi state, RuntimeStore…"; W07 `:692`.

**Gap:** in a DO, the Pi storage facade and RuntimeStore can share one `transactionSync`. If Pi's commit can carry projection rows in the same transaction, the cursor and catch-up path, and its tests, become unnecessary on the DO side. Locally they're only needed because of the separate worker (CLX-09).

**Correction:** add the question to G1: can the custom `SqliteDatabase` facade write projection rows inside Pi's commit?

**Evidence status:** inference; the upstream hook is unverified.

---

## 3. Coverage matrix

| Area | What I verified | Retained findings | Remaining evidence gaps |
|---|---|---|---|
| **Codex** | Process-level broker placeholder in `config.toml` (`profiles/codex/index.ts:71–81`). A placeholder change is a launch change (`launch-config.ts:6–21`), so the plan's immutable generations are needed. MCP is per thread (`configuration.ts:16–21`). There is a single `onRequest` binding (`session.ts:49–51`), which W04 replaces. No idle release exists. | CLX-05, CLX-07 | Whether app-server exits on stdin EOF; whether project config resolves per thread `cwd`. |
| **Cursor** | Worker is keyed by binding/home with a process-level environment (`host-registry.ts:130–131`); CU1–CU6 are carried into W05. | — | CU5 live home-update experiment (already a matrix prerequisite). |
| **OpenCode2 V2** | Embedded `OpenCode.create` per engine (`opencode-sdk/host.ts:63–69`); declining to merge cross-workspace databases is sound. | — | Whether V2 spawns descendants outside launch ownership (for example LSP); I couldn't verify this from the installed SDK. |
| **Pi** | RPC profile/resume/commands/dialogs; owner-login profile; Pi Durable README: store ownership, env-based credentials, no import path, no built-in DO support. | CLX-01, 02, 03, 08, 09, 10 | Pi Durable isn't installed. OAuth support, CLI-extension compatibility and hold/resume semantics are upstream-unverified. |
| **ACP** | Plan correctly limits sharing to per-peer qualification (AC1–AC7). | — | No peer behavior verified. |
| **Claude** | Gated per-conversation spawn (`claude-sdk/process.ts:32–34`); the plan doesn't propose idle reaping. | CLX-05 (gate residency) | — |
| **Local daemon** | Launch gate, ownership scopes, SH2 gate, Electron-as-Node runtime. | CLX-03, 05, 07 | Packaged behavior not run. |
| **Relay** | Provenance, managed lease, deferred grants. | CLX-02 | — |
| **Native cloud VM** | Multi-person credential snapshot; Pi sessions migrate in place. | CLX-04 (pre-existing exposure) | Native-VM Pi Durable composition is lightly specified. |
| **SessionDO / Boat** | Boat `noEnv`, scoped keys (rotation revokes immediately, covered by G3), TTL/auto-stop, stop semantics; D1 lifecycle ownership. | CLX-04, 06, 10 | Boat command/status idempotency (already G2); Cloudflare cross-script deploy order unverified. |

---

## 4. Assumptions I challenged but did not retain

- **Codex per-session MCP or first-party tokens would block sharing.** No: they're per-thread configuration.
- **Placeholder renewal kills shared Codex processes.** This is handled by W04's immutable generations.
- **Boat TTL or auto-stop acts as a second lifecycle owner.** The plan disables TTL; the docs confirm `ttlSeconds: null`.
- **Boat key rotation invalidates every DO.** G3 explicitly covers rotation for multiple holders.
- **W09/W13/W17 form a cycle.** `:819` and `:783` separate contract work from acceptance; the real problem is ownership (CLX-08).
- **Activity and archive race across CP isolates.** D1 conditional writes plus A14 are decisive.
- **Pi's module-global file queue in co-resident DOs.** W01 already gates this without asserting a defect.
- **D1 baseline-only schema guard.** W12 requires a row-preserving upgrade.
- **Claude idle reaper or ACP generic pooling.** The plan correctly rejects both.
- **The DO model loop exceeds invocation limits.** G1's bounded scheduling with alarm checkpoints is a real gate.

---

## 5. Required plan changes, in order

1. **CLX-01:** Record the product decision for incompatible Pi profiles in RPC-free builds; make the importer independent of RPC; define downgrade behavior; add an OAuth parity gate; release local cutover separately from the cloud rows.
2. **CLX-02:** Choose either "park as authorization-required" or a resume-grant intent for relay-admitted local turns; extend G3 to local placement.
3. **CLX-03:** Add rules for worker link loss, holding mutations instead of returning errors, and single-writer store ownership; add the kill-daemon acceptance check.
4. **CLX-04:** Declare the guest a workspace trust domain or gate per-owner isolation; add adversarial sibling reads to A16.
5. **CLX-05:** Add an early Codex quiescent-release slice; remove W04's dependency on W02; add a footprint decision rule; decide whether gate residency is in scope.
6. **CLX-08:** Move `workspace-execution` early; split W15; draw separate local and cloud release subgraphs.
7. **CLX-06, CLX-07, CLX-09, CLX-10** as described above.

---

## 6. Limitations

- This review is based on source and documentation only. Nothing was executed, so there is no runtime, memory or deployment proof.
- Pi Durable isn't installed in this repository. Its claims come from fetched README summaries; the single-writer and environment-credential statements appeared consistently across two fetches.
- External pages were read through a summarizing fetch, so quotes may be lightly paraphrased.
- Not fetched or verified:
  - Boat command/status API pages, which remain G2's responsibility;
  - Cloudflare deploy-ordering rules;
  - OpenCode2 V2 descendant behavior;
  - ACP peers.
- I didn't verify every W-unit file path; spot checks of the named "extend" owners all exist.
