# Fresh Opus 5.5 review of the revised harness and Pi plan

Date: 2026-10-03 (Asia/Kolkata)

Reviewed artifact: [architecture and implementation plan](../architecture/pi-durable-boat-hld.md).

## Revision and user decisions

The plan was updated before this review to specify local continuation authorization, supervisor loss and exclusive Pi store ownership, membership-aware workspace mutation gates, early local Node execution ownership, separate native/local/cloud release cuts and measurable memory outcomes.

The user's subsequent instructions control this revision:

- **No backward compatibility:** remove RPC/history importers, installed-Pi launcher/extension parity, legacy readers, downgrade/mixed-version support and old Box API compatibility. New formats may reject old records; rejection does not authorize deleting data or discarding live execution ownership.
- **One workspace VM is an accepted shared execution trust domain:** per-session scoping means catalog/account selection, request routing, approvals and authorized dispatch. It does not claim confidentiality from arbitrary code inside the same VM. No additional OS isolation or cross-principal credential-admission project was added. Existing never-readable-secret rules and keeping model/provisioning credentials outside the guest remain in scope.

W10 now delivers a clean Pi replacement. W12/W20 support the current schema and explicit old-version refusal. G0 and H8/H9/L12/L13 make the new local recovery, shared-launch and measurement requirements testable. The plan passed structural validation before the reviewer started: 20 units, 20 requirements, 38 acceptance rows, nine Mermaid diagrams, 27 local links, seven anchors and all 40 original audit-claim groups accounted for.

## Result after independent verification

Claude returned **eight candidates: three P1, two P2 and three P3**. Its verdict is GO for baseline/feasibility and bounded independent work, but not ready for full implementation/release. Two findings are strong unresolved correctness/design requirements: **brokered cross-workspace sharing and renewal (F1)**, and **launch ownership surviving a rejected session-store schema (F3)**. Native-VM continuation/lifecycle also needs an explicit placement contract (F4).

The table below qualifies the reviewer output. The raw report is preserved afterwards; recommendations in it are not automatically accepted or silently added to the plan. In particular, this review does not reintroduce backward compatibility or reject the user's shared-VM trust decision.

| ID | Disposition | Verified consequence / next correction |
|---|---|---|
| F1 — broker scope and renewal | Retain P1, with harness-specific qualifications | Current broker IDs include workspace identity. Codex home/provider config and Cursor worker backend selection therefore partition same-account workspaces today. Prove a supported per-member route/credential or another authority-preserving broker contract before claiming brokered cross-workspace sharing. Test forced renewal during concurrent/background work. |
| F2 — CP schema ownership | Retain as P2 sequencing/deployment clarification; reject the claimed requirement for a new migration decision | `resume_turn` needs a D1 constraint/record change, and W08.H should explicitly own the baseline/deployment work for its local release. The plan already permits fresh deployments and unsupported-version refusal. It does not require deleting the current production database, and the user has declined backward compatibility. Remove destructive refusal advice from the supported flow; do not add a row-preserving upgrade requirement. |
| F3 — schema refusal hides launch ownership | Retain P1 as execution safety, not compatibility | Launch rows currently share the RuntimeStore schema. Its mismatch occurs before reconciliation; following the current move-aside advice can hide a surviving process. Define a safe fresh-store action or a precondition proving prior launch retirement, and make new ownership records independent of transcript-schema changes. An old-format importer is not required. |
| F4 — native-VM Pi continuation | Retain P2, remove unsupported timing assertion | The new grant binds an enrolled host, while hosted runtimes also have owner-grant/relay proof paths. Specify the native-VM identity, stop/wake ownership and a dedicated restart/parked-turn acceptance case. The cited ten-minute constant does not prove a wired ten-minute stop behavior. |
| F5 — worker versus embedding | Optional decision refinement; not an established blocker | G0 already compares resource/fault behavior and the plan explicitly values containing Pi crashes away from the daemon. Managed code can still crash or stall. Make the comparison symmetric if useful, but lower RAM alone does not settle the fault-containment tradeoff, and daemon-side tools do not eliminate that benefit. |
| F6 — W10 dependency cycle | Label cleanup only | The cited edges are explicitly recovery/release acceptance integrations under the dependency preamble; both dependency diagrams are acyclic. Separate construction dependencies and release checks more visibly to prevent a literal scheduler from misreading them. No demonstrated implementation deadlock. |
| F7 — DO schema initialization order | Retain P3 concrete initialization test | Current RuntimeStore refuses a nonempty database without its schema marker. Opening Pi tables first could trigger `runtime_store_schema_mismatch`. Give one initializer ownership of ordering and test first boot plus resets between initialization steps. The failure is conditional, not a reproduced deployed-root loss. |
| F8 — durable approval/question proof | Retain P3 earlier feasibility check | End-to-end waits already exist in A5/A13/L12. Make the Pi-specific suspend/answer/resume proof an explicit G0/G1 exit criterion before composition. README silence does not prove the library cannot support it. |

### Important evidence qualifications

**F1:** [Broker binding construction and renewal](../../packages/claxedo-local-server/src/credentials/broker.ts) includes workspace ID, has a one-hour token TTL and uses half-life renewal from [provider projection](../../packages/agent-runtime-contract/src/provider-projection.ts). [Codex profile](../../packages/harness/src/profiles/codex/index.ts) writes the broker URL/header to its home, and [Codex session configuration](../../packages/harness/src/transports/codex-app-server/sessions.ts) defers changes during active turns and refuses replacement with live background tasks. The exact existing refusal is `Claxedo cannot replace the Codex process while background tasks are running. Wait for them to finish or explicitly stop them before changing launch settings.` Whether upstream thread-level overrides solve this remains unverified. The generic Codex unauthorized message quoted by Claude is an existing mapping, not an observed result of a forced-expiry test.

Cursor differs: its [worker backend URL](../../packages/harness/src/transports/cursor-sdk/host-registry.ts) is process-wide, but [Agent options](../../packages/harness/src/transports/cursor-sdk/host.ts) receive an API key per Agent. [configureEntry](../../packages/harness/src/transports/cursor-sdk/index.ts) refuses a busy Agent with `Cursor turn active`; it only reacquires the worker when the binding changes. Therefore, do not generalize Codex's process-wide token replacement to every Cursor renewal. The cross-workspace backend partition is confirmed; live renewal behavior needs its own test. Do not weaken workspace authorization merely by replacing a workspace binding with an owner-wide credential.

**F2/F3/F7:** [CP baseline guard](../../packages/claxedo-server/scripts/control-plane-schema.ts) currently recommends deleting a mismatched D1; that is diagnostic text, not an action performed or authorized here. [RuntimeStore schema guard](../../packages/session-core/src/store-schema.ts) includes `LAUNCH_OWNERSHIP_SCHEMA` and recommends moving a mismatched store aside. [Workspace durable-state initialization](../../packages/workspace-runtime/src/workspace/durable-state.ts) catches the mismatch before reading/reconciling launch rows. The plan's non-destructive-refusal rule is correct, but its implementation work must replace these unsafe recovery instructions and preserve a gate before a fresh store can admit conflicting work. A safe current-version startup/precondition is sufficient; no legacy conversation compatibility is implied.

**F4:** [Runtime session authority](../../packages/claxedo-server/src/routes/runtime-session-authority.ts) distinguishes relay-host, owner-grant and embedded proofs. [Cloudflare driver](../../packages/sandbox-manager/src/drivers/cloudflare.ts) documents provider auto-sleep, but the ten-minute `idleMs` in `lease policy` has no traced stop decision in the inspected manager/server code. The exact hosted stop/wake timing is unverified. Retain the missing native-VM contract, not a fabricated ten-minute failure reproduction.

## Fresh-review provenance and limits

- Actual CLI: `/Users/yashvardhansingh/.local/bin/claude`, `2.1.287 (Claude Code)`.
- Requested and observed reviewer: `claude-opus-5-5`, `--effort high`; all 116 reviewer assistant messages identify Opus 5.5.
- Fresh session `05e41189-88ec-4214-936d-3043eee3125b`, distinct from the prior review; no resume or prior review findings supplied. Tool-log inspection found no attempts to read/search previous review reports or run artifacts.
- Successful exit 0, `is_error: false`, `terminal_reason: completed`, 862,259 ms (about 14 minutes 22 seconds). No permission denials; no subagents.
- Read-only tools used: Read 25, Grep 30, WebFetch 3, Glob 3. No Bash/Edit/Write/Agent tools were available. The CLI used auxiliary Haiku 4.5 for WebFetch summaries; Opus remained the reviewer.
- Primary-plan SHA-256: `3ddf9afcbadcbd9660de6954732e797cb000a0d45501e39fff3008c099c43094`.
- Companion audit SHA-256: `2f30325fcebb3b821d29488805ee0ff8a75546416039596ebbebe109f5eb2fd9`; failure matrix: `2d44eab6ab2ac6c7b83de899c20d4f470a88b7375c811b0f52c8c8a1992720d4`. All three inputs remained unchanged during review and verification.
- Review-start HEAD: `07e99bff79646e402e6469aa042ee2b64f56002a`, branch `dev`. Other work continued in the shared checkout; this task changed only the plan and this new report.
- Coverage correction: Claude calls its reading complete, but the tool log shows direct primary reads through line 1049 of 1064. All 20 units, release cuts, gates and 38 acceptance rows were included; the final 15 lines containing the concluding decisions/checklist were not directly read by Claude. The author checked those lines. Source depth was also uneven across harnesses, as the review's matrix acknowledges.
- No runtime, packaged-client, provider, memory or deployed acceptance was performed. The two highest-priority mechanisms were checked against source, not reproduced. External API possibilities remain feasibility work.

Invocation used a new prompt on stdin:

```sh
claude -p --model claude-opus-5-5 --effort high \
  --output-format stream-json --verbose --safe-mode --strict-mcp-config \
  --disable-slash-commands --no-chrome --no-session-persistence \
  --permission-mode dontAsk --permission-prompts none \
  --tools Read,Glob,Grep,WebFetch,WebSearch \
  --allowedTools Read,Glob,Grep,WebFetch,WebSearch
```

Run artifacts (prompt, snapshots, provenance, full stream and result) are under `/private/tmp/claxedo-all-harness-opus-5-5-fresh-round2-20261003/`. The returned report is preserved below independently of those temporary files.

Validation: `node /private/tmp/validate-pi-durable-complete-plan-round2.mjs` passed; an independent inline Python graph check found the native/local and cloud graphs acyclic (26 and 20 edges), with no cloud unit in the local graph. Inline checks verified unchanged input hashes, correct reviewer identity and no previous-review access. Document validation is not implementation acceptance. No production imports changed, so architecture ratchets/application tests were not run.

## Full fresh Claude response

The following is verbatim reviewer output. Apply the qualifications above when interpreting its priorities, remedies, source claims and coverage statement. F2's migration recommendation and F4's exact idle timeout are not adopted.

---

# Adversarial review: Claxedo harness sharing and Pi execution plan

**Scope.** I read all of `docs/architecture/pi-durable-boat-hld.md` (lines 1–1049): W01–W20, the release cuts, gates G0–G4 and all 38 acceptance rows (H1–H9, L1–L13, A1–A16). The two companion documents served as evidence only. I also read `AGENTS.md` and the source owners each finding cites, plus the pinned Pi Durable README and Boat's API-key page. I did not open `docs/reviews/` or any earlier review output. Everything here comes from reading source and documentation. Nothing was run.

## 1. Verdict

**Starting W01 and other independent safe work: GO.** W01.N, W01.L, W01.C and W04.E (Codex quiescent release) can start now. None of the findings below blocks them. Three findings should become explicit W01 experiments or decisions: F1 goes into W01.N, F2 and F3 into W01.L. W02 and W03 can start design work, but they should not land persisted `RuntimeStore` schema changes until F3 is decided.

**Full implementation and release readiness: NOT READY.** Three P1 problems need a decision before the native-sharing and local-Pi release cuts can be relied on:

- **F1:** the credential broker binding is per workspace and per process. This undermines cross-workspace Codex and Cursor sharing.
- **F2:** the local release cut hides a control-plane D1 schema change. The deploy guard turns that change into "delete the production database".
- **F3:** refusing an old `RuntimeStore` schema also hides the launch-ownership records that safe process ownership depends on.

---

## 2. Findings

### F1 — P1 — The broker credential is per workspace and process-wide, which defeats cross-workspace Codex/Cursor sharing and makes credential renewal a whole-group event
**Confidence:** high for the source facts; medium for the upstream workaround.

**Plan references:**
- `pi-durable-boat-hld.md:42`: N2 says workers are shared "without sharing … brokers or credentials".
- `:134–135`: the Codex and Cursor targets.
- `:193`: the compatibility key includes "account scope where process-global".
- `:240`, and `:361`, where the credential-refresh rule is stated for Pi only.
- W04 at `:701–702`, W05 at `:710–711`, W18 tests at `:832`.
- H1 at `:968` and H2 at `:969`.

**Source evidence:**
- The broker builds the binding from the workspace: `bindingId(orgId, workspaceId, providerId, userId)`. `baseUrl` is that binding's `/bindings/<id>` route, and the placeholder is minted for that binding (`claxedo-local-server/src/credentials/broker.ts:246–248, 478, 496–520`).
- The placeholder lives one hour (`BROKER_TOKEN_TTL_MS`, `broker.ts:60`). Renewal is due at half-life (`agent-runtime-contract/src/provider-projection.ts:212–219`).
- Codex writes `base_url` and `Authorization = "Bearer <placeholder>"` into the home's `config.toml`, so it applies to the whole process (`harness/src/profiles/codex/index.ts:71–81, 146`). The home key hashes `broker:${baseUrl}` (`profiles/codex/home.ts:26–30`).
- The placeholder is part of launch identity; only `expiresAt` is excluded (`harness/src/contract/launch-config.ts:6–17`). A change therefore reopens the Codex process (`codex-app-server/sessions.ts:63–67`). The reopen is deferred while busy (`:58`) and refused while background tasks run (`:84–86`, which is the CX2 refusal text).
- Cursor uses the binding URL as its worker key and sets it process-wide as `CURSOR_BACKEND_URL` (`cursor-sdk/credentials.ts:14–15`, `host-registry.ts:21–22, 28–29`). The `apiKey`, by contrast, is passed per Agent (`cursor-sdk/launch.ts:16`).

**What happens:** a signed-in user selects the same OpenAI or Cursor account in workspaces A and B.
1. The broker gives A and B different binding URLs and different placeholders.
2. If the W04/W05 compatibility key keeps the binding, as the current keys do, A and B never share a process. H1/H2 can then only pass with owner-login (unsigned or machine-login) sessions. The signed-in brokered population gets no cross-workspace saving, so W03's cross-workspace machinery buys them nothing.
3. If an implementer drops the binding from the key to make H1 pass, B's thread runs on A's binding. B's model traffic is then authorized and attributed under A's workspace lease. Nothing raises an exception. When A closes or A's lease generation changes, B starts failing with the existing `Codex rejected the credential. Run \`codex login\` or sync a valid Codex credential, then retry.` (`codex-app-server/translate/turn-errors.ts:12`).
4. Even inside one workspace, the placeholder renews every ~30 minutes, and each renewal needs a process-wide replacement. In a shared process, one busy member defers the replacement and one member with background tasks refuses it (CX2). If the process is not fully idle before expiry, every member runs on an expired placeholder.

**Why the plan's mitigation is not enough:**
- The plan keys groups by "account scope" and requires immutable profile generations; W05 says "credential/plugin changes must not mutate a sibling's launch profile".
- But the real partition today is the workspace-scoped binding plus a 30-minute renewal cycle, not the account.
- Immutable generations turn every renewal into a new group, so groups churn every half hour.
- No unit makes the provider route or credential a per-member (thread or Agent) parameter. No acceptance row runs a brokered account across a renewal.

**Smallest correction:** in W01.N, decide per harness among three options:
- (a) Pass provider route and credential per member. For Codex that means overriding `model_providers` or its headers in thread-level config; for Cursor, a per-Agent backend URL. Both are unverified upstream for 0.159.2 and 1.0.34.
- (b) Make local broker bindings owner-scoped, keeping per-session usage attribution.
- (c) Record an evidenced N1 limit: cross-workspace sharing applies only to owner-login sessions.

This affects W03, W04.S, W05, W18.N and H1/H2/H9.

**Decisive check:** two workspaces with the same brokered account have active Codex (and Cursor) turns while a renewal is forced. Pass means: one process; each member's broker requests carry its own workspace binding; no 401; no replacement blocked past expiry.

**Evidence status:** source-confirmed. The upstream workaround (a) is unverified.

---

### F2 — P1 — The local release cut requires a control-plane D1 schema change, and the deploy guard answers that with "delete the database"
**Confidence:** high.

**Plan references:**
- `:333–335`: the `resume_turn` grant, bound to a "revocable CP admission record" and supporting repeated redemption.
- `:738`: W08.H says "this CP work is owned here and is not deferred to cloud W12".
- `:657`: schema policy lives in W12. "deleting/recreating an existing database … is not implicitly authorized".
- `:774–775`: W12 owns the baseline and deploy scripts.
- `:858` and `:922`: the local cut has "No cloud-unit prerequisite".

**Source evidence:**
- `session_turn_grants.intent` has `check (intent in ('child_completion', 'queued_prompt'))`. Redemption is a single `redeemed_at`/`redeemed_turn_id` pair (`claxedo-server/migrations/control-plane/0001_baseline.sql:547–564`).
- The deploy guard accepts only an empty D1 or the exact baseline. Otherwise it throws: `Control-plane D1 does not hold the current 0001_baseline.sql (recorded migrations: …). Its rows cannot be converted: delete it with \`wrangler d1 delete <database>\` and deploy again, which recreates it empty.` (`claxedo-server/scripts/control-plane-schema.ts:38–41`).

**What happens:**
1. W08.H adds the `resume_turn` intent, the admission record and repeatable redemption. Each of these changes the baseline.
2. Deploying the local-cut control plane against the live D1 fails with the error above.
3. The only path the tooling offers deletes every account, enrollment, share and session index. That breaks the relay path the local cut itself needs.
4. W12 later changes the baseline again for root bindings, placement epochs and activity leases. That forces a second wipe.

**Why the plan's mitigation is not enough:** the plan correctly says CP work is part of W08.H, and that deleting an existing database is not implicitly authorized. But the schema and deploy owner sits in W12, which the local cut explicitly excludes. No unit decides how a local-only release changes the CP schema.

**Smallest correction:**
- Create one CP schema-transition step that both W08.H and W12 consume, and land all planned CP tables and constraints in a single baseline change.
- Have the user decide explicitly between a fresh deployment (stating its consequences: accounts, enrollment, shares) and a forward-only, row-preserving migration. Plan line 657 currently rejects the latter. A forward-only migration is not downgrade or mixed-version support.

This affects W08.H, W12, W20.L/C and the release-cut table.

**Decisive check:** deploy the local-cut control plane against a copy of a current-baseline D1 and record the outcome. Then redeem `resume_turn` twice across two daemon restarts.

**Evidence status:** source-confirmed.

---

### F3 — P1 — Refusing an old `RuntimeStore` also hides launch-ownership records, and the store's own refusal advice orphans live processes
**Confidence:** high for the mechanism; medium for how often it triggers.

**Plan references:**
- `:35`: "Rejection does not … terminate unowned live execution".
- `:566`: `RuntimeStore` gains Pi bindings, capability revisions and recovery facts.
- `:682–683`: W02 extends the persisted session/config schema.
- `:757`: W10's live-ownership rule.
- `:758`: W10 tests that "generic unresolved-launch gates survive replacement".
- `:851`: W20 tests that the store "refuses without data changes".

**Source evidence:**
- The schema identity is the full schema text. Any change throws `RuntimeStoreSchemaMismatchError` with the message `…was written by a different schema than this build declares. It is not migrated: move it aside to start with an empty store.` (`session-core/src/store-schema.ts:313–355`).
- `LAUNCH_OWNERSHIP_SCHEMA` is part of that same schema (`:310`).
- `workspaceDurableState.open()` turns the mismatch into a 503 for every request, reads included, before `reconcileLaunchOwnership` runs (`workspace-runtime/src/workspace/durable-state.ts:27–50, 74–80`).
- Launch rows live in `store.database()` (`:37`). No daemon-level ownership store exists today; the only `standalone` users are volatile or test code.

**What happens:**
1. The old daemon generation leaves an unresolved gated launch: a crash, a `retire_failed`, or an update while a Codex background terminal or Pi RPC process is still running.
2. The new build changes the `RuntimeStore` schema (W02/W08/W15). Workspace A now returns 503 `runtime_store_schema_mismatch` for all six harnesses.
3. The user follows the message and moves the store aside. The new empty store has no unresolved launches, so mutations are admitted.
4. New launches then run alongside the orphaned process group in the same directory and agent storage. Nothing raises an exception; this is silent concurrent execution.

**Why the plan's mitigation is not enough:** W10 requires the "generic launch owner" to verify retirement, but those generic records sit inside the store the new build refuses to open. "Use a fresh … store where necessary" is exactly the move-aside path.

**Smallest correction:**
- Before any persisted `RuntimeStore` change lands, move launch ownership (and W03 memberships and Pi writer claims) into the W03 host ownership store, with its own independently versioned schema.
- For this first transition, either reconcile the ownership table when its own definition is unchanged, or refuse to create a fresh workspace store while the old store's ownership cannot be read.
- Replace the "move it aside" guidance with a supported fresh-store action that checks ownership first.

This affects W02, W03, W08.H, W10, W20.L.

**Decisive check:** kill the daemon while a gated Codex or Pi process is live in workspace A. Start a build with a changed schema and use the supported fresh-store path. Pass means no mutation or launch is admitted in A until the old group is verified retired, and the old store bytes are unchanged.

**Evidence status:** the mechanism is source-confirmed. The transition sequence is an inference.

---

### F4 — P2 — Native-VM Pi is in the local release cut without a continuation identity, lifecycle rule or acceptance row
**Confidence:** medium-high.

**Plan references:**
- `:55`: R4 lists native-VM placement.
- `:333`: the grant is bound to the "enrolled host identity".
- `:775`: "no DO host may impersonate an enrolled local host".
- `:922`: the local cut covers "L1–L13 through … current native-VM paths".
- L1–L13 (`:977–989`) only describe local and relay scenarios.

**Source evidence:**
- Cloud runtimes prove themselves through a relay-host Relay Host Token (RHT) or an `owner-grant`. Neither is an enrolled host (`claxedo-server/src/routes/runtime-session-authority.ts:96–109`).
- Native sandboxes stop after 10 idle minutes (`sandbox-manager/src/lease-policy.ts:30–33`). Cloudflare sandboxes "auto-sleep on inactivity" (`drivers/cloudflare.ts:399–403`).

**What happens:** a Pi turn in a native cloud VM parks on an approval, or the VM restarts.
1. W15.L recovery tries to redeem a `resume_turn` grant bound to an enrolled host the VM does not have.
2. The turn either parks as `authorization_required` indefinitely, or someone invents an ad-hoc binding.
3. Nothing defines whether a parked or scheduled Pi turn keeps the sandbox awake, or who wakes it for due work.

**Why the plan's mitigation is not enough:** R8's "requires the machine and daemon to run" covers laptops. It does not say what happens in a VM that the control plane idles out.

**Smallest correction:** either drop native-VM from the local cut until it is defined, or specify:
- a continuation binding (owner-grant or placement-epoch based);
- the idle/stop interaction and whether checkpoints capture the stores;
- an acceptance row for native-VM restart and idle stop during a parked turn.

This affects W08.H, W12 and W15.L.

**Evidence status:** source-confirmed for the authority and idle facts; the gap is an inference.

---

### F5 — P2 — The embedded-versus-worker decision for local Pi is lopsided, and the plan's own constraints weaken the worker's justification
**Confidence:** medium.

**Plan references:**
- `:315`: the decision only flips if "the separate worker fails the declared … budgets".
- `:631` and L13 (`:989`).
- `:321–327`: the costs that exist only because of the worker: the supervisor lease, cross-process writer claims, IPC schemas and a per-group gate.
- Counter-evidence inside the plan:
  - `:327`: every file, process and MCP operation is still executed by the daemon-side executor, so a stalled daemon still stalls Pi.
  - `:319` and `:359`: only managed extensions are admitted, which removes the arbitrary-extension crash source the worker was meant to contain.
  - `:113` and `:136`: OpenCode2 already embeds a full agent engine in the daemon.

**Why it matters:** if both options meet the budgets, the plan keeps the worker even if embedding is measurably cheaper (no extra Node heap and no gate wrapper) and removes the L13 supervisor-loss contract entirely. That conflicts with N7's purpose. The user's accepted scope says "compatible worker", which does not require a separate OS process.

**Smallest correction:** make G0 a symmetric choice with predeclared criteria. Name the specific failure-containment property the worker must demonstrate, and choose embedded execution when it does not. Settle this before W08.H, because W07's portable transport keeps the switch cheap. This affects W01.L, W08.H and L13.

**Evidence status:** inference from the plan's own text.

---

### F6 — P3 — W10's dependency text forms a cycle and disagrees with the diagram
**Confidence:** high.

**References:**
- `:754`: W10 depends on "W15.L/W20.L".
- W20.L consumes W19.L (`:847`), which consumes W16.L and W18.L, which both consume W10 (`:810`, `:829`, diagram `:881–889`).
- The diagram has no W15.L → W10 edge.

**Effect:** whoever owns W10 cannot tell whether removing RPC must wait for the local release. The rule at `:856` ("acceptance integrations do not require both sides") resolves this only if a reader applies it.

**Correction:** relabel W10's W15.L/W20.L references as acceptance integrations, or move the RPC deletion into W20.L.

---

### F7 — P3 — Table-creation order inside SessionDO's shared SQLite can permanently strand a root
**Confidence:** high for the mechanism.

**References:**
- Plan `:569`, `:574` and `:578`: two schemas share one DO database, and the plan says "open the two local stores" without fixing an order.
- `store-schema.ts:338–354`: any non-`_cf_` table present without `runtime_store_schema` is treated as a mismatch.

**What happens:** if Pi's DO storage creates its tables before `RuntimeStore` initializes on a fresh root, the root returns `runtime_store_schema_mismatch` forever. A DO has no "move aside" option. Nothing else in the store raises an error.

**Correction:** W14 should fix the initialization order (or exclude Pi tables from the emptiness check) and add a test that opens Pi storage first.

---

### F8 — P3 — No feasibility gate decisively covers approval and question waits in Pi Durable
**Confidence:** medium.

**References:**
- Plan `:354` and `:445` require durable approval and question waits.
- W01 proofs at `:674` and G0/G1 at `:649–650` name "mutation holds" and "interrupted-tool hold" only.
- The pinned README documents `beforeTool` returning `{ block }` and an `interrupted` result after a crash, and documents no way to suspend for external input ([README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)).

**Why it matters:** in a DO, approvals routinely outlast object eviction, so a held tool call is the normal path, not a fault path. A5, A13 and L12 do cover it, so this is late discovery rather than an omission.

**Correction:** add a G0/G1 pass criterion. A pending approval or question survives process exit or eviction, and after the answer the original tool-call ID executes exactly once with no new model call. `block` must not be used to represent a pending approval.

---

## 3. Coverage matrix

| Path | What I verified | Remaining gaps |
|---|---|---|
| Codex | Process-wide `CODEX_HOME`/`config.toml` broker credential; placeholder inside launch identity; per-thread `mcp_servers` (`configuration.ts:20`); `thread/unsubscribe` and `thread/closed` exist in the generated protocol; shell environment is the same for every session (`launch.ts:16`); pinned 0.159.2 | Whether a thread-level provider/header override works (F1) |
| Cursor | Worker keyed by binding URL plus `HOME`; `CURSOR_BACKEND_URL` is process env; `apiKey` is per Agent; 1.0.34 | Whether the SDK accepts a per-Agent backend URL |
| OpenCode2 V2 | beta-19271 pin matches; keeping per-workspace engines inside the daemon is consistent | Child processes (MCP/LSP) per engine not measured |
| Pi | No Pi Durable dependency exists yet; README confirms single-process storage ownership, `replay: "safe"`, `beforeTool` block only; RPC refusal text quoted correctly | Pi Durable source, module-global state, workerd behaviour |
| Claude | 0.3.285 pin; plan keeps one CLI per concurrent conversation | Gate wrapper cost per conversation (see section 4) |
| ACP | 1.5.1 pin; qualification is per peer | Actual peer behaviour |
| Local | Durable-state gate, ownership store, broker, schema identity, deferred grants | Daemon update/drain behaviour during upgrade |
| Relay | Relay-host and deferred-grant bindings exist | — |
| Native cloud | Owner-grant authority, 10-minute idle stop, Cloudflare auto-sleep | F4 |
| SessionDO/Boat | Schema-order trap; Boat sandbox-scoped key can "prompt, exec, … host, snapshot", and rotation revokes immediately | Boat command and `noEnv` docs not fetched; that is unavailable evidence, not evidence against the plan |

## 4. Challenged but not retained

- **Shared-launch blast radius (H8 fences A and B).** This matches the existing gate's rationale, and L10 bounds capacity.
- **Boat key capabilities and rotation.** G3 explicitly requires proving the restrictions or rejecting the configuration, and `:617` covers cutover.
- **DO eviction and unresolved promises.** `:610` already rejects promise-based execution.
- **Co-resident DO module-global state.** G1 and the W14 test cover it.
- **Activity/archive race.** A14 and the D1 conditional writes in G2 cover it.
- **Launch-gate wrapper memory.** The gate is a Node process that outlives its payload (`launch-gate-child.ts:45–48`). The sampled wrappers were roughly a third of summed RSS, and one wrapper had about 13 MB physical footprint. `:675` puts gate residency in scope for measurement, and W04.E retires the gate with its payload. A lighter gate remains an unexplored option for Claude and ACP, which cannot share processes.
- **Codex memory premise.** H9 requires improvement beyond the noise bound rather than a lower process count, and W04.E targets the evidenced single-workspace case directly.

## 5. Required plan changes, in order

1. **F2:** one CP schema-transition step consumed by both W08.H and W12, plus an explicit user decision between a fresh deployment and a forward-only migration.
2. **F3:** move launch, membership and writer ownership out of the versioned `RuntimeStore` before any schema change lands, and define a safe fresh-store path.
3. **F1:** a W01.N experiment on broker binding and renewal, then a per-harness decision (per-member credential, owner-scoped binding, or evidenced limit), and new H1/H2 renewal acceptance.
4. **F4:** define native-VM Pi continuation and lifecycle, or remove native-VM from the local cut.
5. **F5:** make G0's embedded-versus-worker choice symmetric.
6. **F6–F8:** fix the W10 dependency labels, the DO initialization order and the approval-hold gate criterion.

**Limitations of this review:**
- Source and documentation review only; I ran no tests and observed no running process.
- Pi Durable source, Boat command/`noEnv` docs, the Codex thread-level provider override and a Cursor per-Agent backend are unverified.
- The working tree has unrelated uncommitted changes, so these observations may not match the running packaged build.
