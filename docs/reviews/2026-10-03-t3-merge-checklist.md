# T3 merge: all 339 input items

This is the original applicability snapshot. The seven defects referenced by its Bug rows are addressed in [the follow-up implementation](2026-10-03-t3-merge-fixes.md); feature gaps and Verify rows remain separate work.

Companion to [the findings and evidence report](2026-10-03-t3-merge-applicability.md). Numbers follow the user's original pasted order. Snapshot: 2026-10-03, `dev` at `0c272d491f115f4c7093889c2bf446cc365bc319` plus existing working-tree edits.

This is a source-level applicability triage. Have = a corresponding mechanism exists, not all acceptance passed. Partial = mixed support or narrower behavior. Gap = absent from the inspected authoritative surface. Different = T3-specific architecture/product choice or explicit local policy difference. Bug = actionable finding in the report. Verify = unresolved acceptance, not a clean bill of health.

**Have: 71** | **Partial: 78** | **Gap: 52** | **Different: 49** | **Bug: 10** | **Verify: 79**

Counts refer to input bullets, not independent bugs. Multiple Bug rows map to the same seven findings.

| # | Original item | Assessment | Reason / evidence limitation |
| --- | --- | --- | --- |
| 001 | switch providers and accounts mid-thread with context handoff | Partial | Harness handoff/live settings/account UI exist; full account and model-specific retention/mobile parity is not established. |
| 002 | switch back to previously used providers | Partial | Native source is retained until the first message on the replacement; later return uses portable history. |
| 003 | change models and options between turns | Have | Live model/effort controls acknowledge before persistence; focused model-settings tests pass. |
| 004 | remember options per provider and model | Partial | Harness handoff/live settings/account UI exist; full account and model-specific retention/mobile parity is not established. |
| 005 | switch providers in existing mobile threads | Partial | Harness handoff/live settings/account UI exist; full account and model-specific retention/mobile parity is not established. |
| 006 | queue provider switches without stopping current work | Gap | Busy handoff is refused; the durable prompt queue has no ordered harness-switch operation. |
| 007 | apply queued switches in delivery order | Gap | Busy handoff is refused; the durable prompt queue has no ordered harness-switch operation. |
| 008 | recover failed native resumes with portable context | Different | Native resume failure deliberately refuses instead of creating a fallback conversation; requires an explicit policy change. |
| 009 | show provider/model changes in the timeline | Partial | Harness handoff/live settings/account UI exist; full account and model-specific retention/mobile parity is not established. |
| 010 | transfer short conversations intact | Bug | B3: single-assistant map and hard-coded User attribution lose transcript fidelity. |
| 011 | select relevant history from longer conversations | Partial | Newest history suffix under fixed character limits; no relevance selection. |
| 012 | preserve message order and attribution during handoffs | Bug | B3: single-assistant map and hard-coded User attribution lose transcript fidelity. |
| 013 | carry partial failed/interrupted work into handoffs | Bug | B2: assistants carrying an error are filtered out, including useful partial progress. |
| 014 | keep new prompts separate and unshortened | Have | turnPrompt keeps new prompt parts separate from the system handoff transcript. |
| 015 | let agents retrieve omitted history | Partial | session_transcript pages stored history; no dedicated omitted-history manifest or handoff budget protocol. |
| 016 | inject native history into supported codex versions | Gap | Portable text-prefix/system handoff with fixed character caps; no native Codex injection or configurable token-fit admission. |
| 017 | reject handoffs that cannot fit available context | Gap | Portable text-prefix/system handoff with fixed character caps; no native Codex injection or configurable token-fit admission. |
| 018 | configure handoff history budgets | Gap | Portable text-prefix/system handoff with fixed character caps; no native Codex injection or configurable token-fit admission. |
| 019 | exclude private reasoning, live tool state and historical attachments from handoffs | Bug | B1: any part with text is exported, including reasoning; live tool-state filtering is also missing. |
| 020 | fork from a selected finished run | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 021 | choose a fork's provider on its first message | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 022 | delay fork session creation until needed | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 023 | use native forks where supported | Partial | OpenCode and capable ACP peers expose native fork; Codex/Claude/Pi/Cursor transports do not. |
| 024 | use portable context for cross-provider forks | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 025 | fork codex at the selected turn | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 026 | fork claude from earlier turns | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 027 | fork pi into another workspace | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 028 | fork cursor through portable context | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 029 | preserve inherited history in forks | Verify | Fork owner binds a child; inherited transcript/boundary/active-source behavior needs a dedicated fork acceptance test. ACP ignores messageId. |
| 030 | keep claude forks usable after source rollback | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 031 | fork failed, interrupted, cancelled and limited runs | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 032 | fork before checkpoint finalization when provider work is finished | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 033 | reject active or already-rolled-back fork sources | Verify | Fork owner binds a child; inherited transcript/boundary/active-source behavior needs a dedicated fork acceptance test. ACP ignores messageId. |
| 034 | merge fork context back into its source | Gap | No general selected-run portable fork workflow. Native fork operation exists only for OpenCode/advertising ACP peers. |
| 035 | expose fork and merge-back tools to agents | Different | MCP inventory explicitly excludes fork; merge-back is not implemented. Exclusion is a policy decision, not an accidental missing import. |
| 036 | wait for mobile fork state before navigation | Gap | No corresponding selected-run mobile fork-navigation workflow in the inspected app/session surface. |
| 037 | delegate tasks across providers and models | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 038 | track delegated tasks as child threads | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 039 | choose child provider, model, options and role | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 040 | inherit compatible parent settings | Partial | Parent standing instructions/permission ceiling and explicit model-group slots are reused; not blanket inheritance of all settings. |
| 041 | give children explicit task context rather than copying parent history | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 042 | delegate asynchronously or wait | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 043 | include nested work in task completion | Gap | Host child settlement does not wait for descendant completion; nested-work task completion is not represented here. |
| 044 | keep children running after wait timeouts | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 045 | wake parents when children finish | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 046 | batch eligible child results | Gap | offerWakes selects one pending child and starts its wake, not a batch of results. |
| 047 | deliver later child completions in subsequent wakes | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 048 | preserve original results across follow-up work | Partial | Transcript retains past messages, but subagent status/summary reads latest child output rather than immutable per-run result records. |
| 049 | inspect, follow up with and cancel delegated tasks | Bug | B4: inspect/cancel/send exist, but a completed child follow-up remains terminal and emits no later wake. |
| 050 | distinguish working, waiting-for-children and result-ready states | Partial | Current statuses are pending/running/paused and terminal outcomes, not separate waiting-for-children/result-ready phases. |
| 051 | reject unavailable delegation targets | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 052 | prevent child permission escalation | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 053 | discover live provider/model capabilities through agent tools | Have | Host-created subagent tools/lifecycle and permission-ceiling path exist; relevant focused tests pass. Later runs are separately broken under B4. |
| 054 | create ordinary threads individually or in batches | Partial | session_create creates one session per call; no batch creation API in tool inventory. |
| 055 | create idle threads or launch them with prompts | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 056 | launch threads in project roots or worktrees | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 057 | choose worktree base branches for stacked work | Gap | Agent session-create worktree input exposes name, not an explicit base branch for stacked work. |
| 058 | launch scratch threads through agent tools | Verify | Scratch/projectless launch semantics need checking against placement admission; not proven by generic session_create. |
| 059 | include attachments in thread launches | Partial | Session launch accepts prompt data; complete attachment parity across launch/placement paths needs acceptance. |
| 060 | list and filter project threads | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 061 | search thread titles and content | Gap | Inspected agent session-list/transcript tools do not expose full-text thread search. |
| 062 | read messages, plans and activity across threads | Partial | Read/send/rename/inspection exist; plans/activity paging, run-specific wait, title regeneration and restart are not all one matching API. |
| 063 | page through history and long items | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 064 | send, queue, steer or restart another thread | Partial | Read/send/rename/inspection exist; plans/activity paging, run-specific wait, title regeneration and restart are not all one matching API. |
| 065 | wait for a selected run | Gap | No selected-run wait, linked-PR mutation or human-attached cross-project-reference feature in the inspected session tool inventory. |
| 066 | request thread interruption | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 067 | rename threads and regenerate titles | Partial | Read/send/rename/inspection exist; plans/activity paging, run-specific wait, title regeneration and restart are not all one matching API. |
| 068 | link and unlink pull requests | Gap | No selected-run wait, linked-PR mutation or human-attached cross-project-reference feature in the inspected session tool inventory. |
| 069 | inspect lineage, workspace, run and request state | Partial | Read/send/rename/inspection exist; plans/activity paging, run-specific wait, title regeneration and restart are not all one matching API. |
| 070 | attribute agent messages to their source threads | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 071 | allow cross-project reads through human-attached references | Gap | No selected-run wait, linked-PR mutation or human-attached cross-project-reference feature in the inspected session tool inventory. |
| 072 | keep ordinary thread access project-scoped | Different | Runtime tools use caller session/own-child kinship plus project/workspace authorization; stricter than general project-wide thread writes. |
| 073 | expose retry keys on supported agent operations | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 074 | distinguish interruption requests from confirmed stops | Have | Session tools expose create/start, placement, list, transcript paging, recovery-based cancellation, authors and supported request IDs. |
| 075 | let agents inspect, edit, cancel and reorder queues | Different | Queue tools are explicitly excluded by MCP_OPERATIONS_WITHOUT_TOOLS, although client/server queue controls exist. |
| 076 | let agents promote queued messages to steering | Different | Queue tools are explicitly excluded by MCP_OPERATIONS_WITHOUT_TOOLS, although client/server queue controls exist. |
| 077 | let agents answer supported questions, not permission approvals | Have | Question answer tools exist; permission_reply is gated to human credentials/approve scope, not ordinary runtime agent authority. |
| 078 | let agents change their own provider/model/options | Have | session_handoff maps to session config write; live config/model controls exist. |
| 079 | let agents pin, snooze, settle, archive and mark threads unread | Gap | Inspected first-party tool registry has no matching snooze/read-state/schedule/project-clone/pending-attachment/preferences/preview tool family. |
| 080 | let agents create and manage scheduled tasks | Gap | Inspected first-party tool registry has no matching snooze/read-state/schedule/project-clone/pending-attachment/preferences/preview tool family. |
| 081 | let agents manage projects and clone repositories | Gap | Inspected first-party tool registry has no matching snooze/read-state/schedule/project-clone/pending-attachment/preferences/preview tool family. |
| 082 | expose name-only project creation to agents | Gap | Inspected first-party tool registry has no matching snooze/read-state/schedule/project-clone/pending-attachment/preferences/preview tool family. |
| 083 | let agents prepare, send and discard pending attachments | Gap | Inspected first-party tool registry has no matching snooze/read-state/schedule/project-clone/pending-attachment/preferences/preview tool family. |
| 084 | let agents inspect and hand off into worktrees | Partial | Worktree creation/placement and workspace inspection exist; rebinding a running thread into a worktree is not established. |
| 085 | rebind threads and restart sessions during worktree handoff | Partial | Worktree creation/placement and workspace inspection exist; rebinding a running thread into a worktree is not established. |
| 086 | expose scoped environment preferences to agents | Gap | Inspected first-party tool registry has no matching snooze/read-state/schedule/project-clone/pending-attachment/preferences/preview tool family. |
| 087 | let agents list and close previews | Gap | Inspected first-party tool registry has no matching snooze/read-state/schedule/project-clone/pending-attachment/preferences/preview tool family. |
| 088 | add first-class pi integration | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 089 | support pi 1.0 | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 090 | reuse pi installations and authentication | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 091 | configure pi executable, environment and arguments | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 092 | discover pi models and thinking levels | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 093 | preserve pi's default thinking level | Verify | Default thinking-level preservation needs a turn-start probe with an unset override. |
| 094 | support pi native resume, fork, rollback and steering | Partial | Pi resume and steering exist; transport exposes no fork/rollback operation. |
| 095 | integrate pi with t3's queue and context handoffs | Partial | Shared queue/handoff paths apply to Pi, including handoff bugs B1-B3. |
| 096 | show pi context usage | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 097 | expose pi skills in the picker | Verify | Pi commands/context are present; exact skill-picker exposure needs UI acceptance. |
| 098 | load pi user/project extensions and context | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 099 | render pi extension dialogs in the composer | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 100 | show pi extension notifications in the work log | Have | PiRpcTransport, version gate, profile/launch, config catalog and extension UI/event mapping provide counterparts; not all run live this review. |
| 101 | bridge t3 tools into pi | Partial | Pi MCP delivery exists; registry marks built-in Pi MCP differently. Full first-party tool reach needs launch-level verification. |
| 102 | show pi example-subagent progress and results | Gap | Pi transport explicitly declares subagents:false; example-extension child progress parity is not established. |
| 103 | fall back to pi default when discovery stalls | Different | Do not add a silent model-discovery fallback under this repository's explicit no-fallback policy. |
| 104 | enforce pi tool approvals by permission mode | Gap | Pi declares requests.permissions:false; native per-tool permission approval parity is absent. |
| 105 | hide unsupported pi auto mode | Verify | Validate the actual offered Pi mode set and permission-change continuation rather than infer it from generic controls. |
| 106 | resume pi sessions after permission changes | Verify | Validate the actual offered Pi mode set and permission-change continuation rather than infer it from generic controls. |
| 107 | detect opencode 1.x versus 2.x | Different | Claxedo embeds the OpenCode SDK engine; T3's legacy-version/external-server launch and orphan-process migration is not the same runtime architecture. |
| 108 | add opencode 2 runtime support | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 109 | retain limited opencode 1.x support | Different | Claxedo embeds the OpenCode SDK engine; T3's legacy-version/external-server launch and orphan-process migration is not the same runtime architecture. |
| 110 | launch local or connect to existing opencode 2 servers | Different | Claxedo embeds the OpenCode SDK engine; T3's legacy-version/external-server launch and orphan-process migration is not the same runtime architecture. |
| 111 | render opencode 2 text, reasoning and tools | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 112 | track opencode 2 models, history, context and usage | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 113 | handle opencode 2 approvals and structured questions | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 114 | map permission modes to opencode 2 rules | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 115 | support opencode 2 native steering, forks and rollback | Partial | OpenCode fork exists; full native steering/rollback parity is not established by this review. |
| 116 | support opencode 2 compaction and plan mode | Verify | Requires specific engine compaction/plan/question/stream failure cases; no broad parity claim. |
| 117 | discover opencode workspace/session inventory | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 118 | show opencode child sessions as subagent threads | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 119 | route child requests to parents | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 120 | preserve opencode background children and parent wake-ups | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 121 | inject t3 tools into local opencode 2 servers | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 122 | reconcile opencode sessions after restart | Partial | Embedded engine provides corresponding transport/session/config/request surfaces; exact version and background/restart cases were not all exercised. |
| 123 | reject unsupported opencode question fields explicitly | Verify | Requires specific engine compaction/plan/question/stream failure cases; no broad parity claim. |
| 124 | fix opencode prompt-admission and cancellation races | Partial | Deadline/signal cancellation tests pass; this does not cover every prompt-admission race. |
| 125 | fail broken opencode streams instead of hanging | Verify | Requires specific engine compaction/plan/question/stream failure cases; no broad parity claim. |
| 126 | clean up orphaned opencode servers | Different | Claxedo embeds the OpenCode SDK engine; T3's legacy-version/external-server launch and orphan-process migration is not the same runtime architecture. |
| 127 | move cursor execution to its official sdk | Have | CursorSdkTransport already imports the official @cursor/sdk; no CLI-to-SDK migration needed. |
| 128 | add cursor browser login across clients | Partial | Account/SDK launch and tool/profile surfaces exist; exact client authentication/config migration parity needs acceptance. |
| 129 | store cursor credentials per execution-environment instance | Partial | Account/SDK launch and tool/profile surfaces exist; exact client authentication/config migration parity needs acceptance. |
| 130 | discover cursor sdk models | Have | Cursor config/model operations exist and shared runtime model-setting controls are present. |
| 131 | support cursor model changes between turns | Have | Cursor config/model operations exist and shared runtime model-setting controls are present. |
| 132 | load cursor project skills and rules | Partial | Account/SDK launch and tool/profile surfaces exist; exact client authentication/config migration parity needs acceptance. |
| 133 | support cursor images, reasoning, plans, todos and tools | Partial | Account/SDK launch and tool/profile surfaces exist; exact client authentication/config migration parity needs acceptance. |
| 134 | inject t3 tools into cursor | Partial | Account/SDK launch and tool/profile surfaces exist; exact client authentication/config migration parity needs acceptance. |
| 135 | resume cursor local agents | Verify | Native resume/steering/retries/child UX/recovery/sandbox guarantees require provider-specific cases, not SDK presence alone. |
| 136 | implement cursor steering through interrupt/restart | Verify | Native resume/steering/retries/child UX/recovery/sandbox guarantees require provider-specific cases, not SDK presence alone. |
| 137 | display cursor native children as read-only threads | Verify | Native resume/steering/retries/child UX/recovery/sandbox guarantees require provider-specific cases, not SDK presence alone. |
| 138 | enable cursor sdk retries | Verify | Native resume/steering/retries/child UX/recovery/sandbox guarantees require provider-specific cases, not SDK presence alone. |
| 139 | recover abandoned cursor runs and shell-start failures | Verify | Native resume/steering/retries/child UX/recovery/sandbox guarantees require provider-specific cases, not SDK presence alone. |
| 140 | replace cursor cli/endpoint controls with sdk configuration | Partial | Account/SDK launch and tool/profile surfaces exist; exact client authentication/config migration parity needs acceptance. |
| 141 | use cursor sdk sandboxing in restricted modes | Verify | Native resume/steering/retries/child UX/recovery/sandbox guarantees require provider-specific cases, not SDK presence alone. |
| 142 | add acp registry search and onboarding | Gap | Inspected connection/registry surfaces do not establish an ACP marketplace installer with checksum verification. |
| 143 | install compatible registry agents on the selected server | Gap | Inspected connection/registry surfaces do not establish an ACP marketplace installer with checksum verification. |
| 144 | verify registry checksums when supplied | Gap | Inspected connection/registry surfaces do not establish an ACP marketplace installer with checksum verification. |
| 145 | support existing executable overrides | Have | Configured ACP executables, negotiated models/options/modes/commands and filtered first-party MCP delivery exist. |
| 146 | share browser/terminal authentication across clients | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 147 | support mobile terminal-auth responses | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 148 | retry, cancel and verify provider authentication | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 149 | discover acp models, options and native commands | Have | Configured ACP executables, negotiated models/options/modes/commands and filtered first-party MCP delivery exist. |
| 150 | map advertised acp plan/build modes | Have | Configured ACP executables, negotiated models/options/modes/commands and filtered first-party MCP delivery exist. |
| 151 | refresh pickers after runtime configuration changes | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 152 | negotiate newer acp with older-version fallback | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 153 | render acp usage, reasoning, plans and compaction | Partial | Usage/reasoning/plans are mapped; README explicitly says session.compaction is not advertised. |
| 154 | list/import native sessions where supported | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 155 | deduplicate repeated native-session imports | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 156 | preserve user-renamed titles during imports | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 157 | render acp resources and explicit unsupported-media placeholders | Partial | Negotiated resources and explicit unsupported-part refusal exist; placeholder-rendering parity is not established. |
| 158 | show old/new-text file diffs | Have | ACP translation documents old/new diff presentation and search/list distinctions; not live-rendered in this review. |
| 159 | distinguish file search from web search | Have | ACP translation documents old/new diff presentation and search/list distinctions; not live-rendered in this review. |
| 160 | expose t3 orchestration to compatible acp agents | Have | Configured ACP executables, negotiated models/options/modes/commands and filtered first-party MCP delivery exist. |
| 161 | improve devin terminals, questions and child-agent presentation | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 162 | use allow-once for automatic acp approvals | Verify | Authentication/mobile/version-negotiation/import/Devin/automatic-approval details were not verified end to end. |
| 163 | use fresh sessions where native acp rewind is unavailable | Different | Fresh replacement on unsupported rewind would be a new fallback policy; not an automatic bug fix. |
| 164 | preserve claude continuity through resume, wake and idle release | Partial | Claude resume/live settings/steering mechanisms exist; full idle-release and option-change continuity matrix was not run. |
| 165 | preserve claude steering state and model options | Partial | Claude resume/live settings/steering mechanisms exist; full idle-release and option-change continuity matrix was not run. |
| 166 | allow claude steering despite next-turn option changes | Partial | Claude resume/live settings/steering mechanisms exist; full idle-release and option-change continuity matrix was not run. |
| 167 | restore claude questions, plans, todos and implement actions in v2 | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 168 | support claude questions in plan mode | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 169 | restore claude resume compaction | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 170 | correct claude post-compaction usage | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 171 | preserve claude read-image previews | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 172 | separate claude parent and child usage | Have | Child-owned usage and idle background-delivery focused tests pass; parent/child routing is an existing mechanism. |
| 173 | keep child output and reasoning in child threads | Have | Child-owned usage and idle background-delivery focused tests pass; parent/child routing is an existing mechanism. |
| 174 | preserve resumed child identity and requested models | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 175 | correct nested claude child ownership and wake routing | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 176 | stop completed claude children appearing active | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 177 | separate claude background replies from queued prompts | Have | Child-owned usage and idle background-delivery focused tests pass; parent/child routing is an existing mechanism. |
| 178 | prevent background turns prematurely completing queued compaction | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 179 | label claude monitors correctly | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 180 | preserve claude limit-reset information | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 181 | remove the old short timeout on long claude t3-tool calls | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 182 | expand home-directory shortcuts in provider executable paths | Verify | Applicable Claude behavior; exact plan/compaction/media/identity/limit/path/timeout scenarios require additional provider-boundary acceptance. |
| 183 | fix codex routing through shared app-server sessions | Partial | Codex app-server transport/recovery/translation surfaces exist; startup-stop and child tests pass, full per-bullet acceptance not run. |
| 184 | unload detached codex threads | Partial | Codex app-server transport/recovery/translation surfaces exist; startup-stop and child tests pass, full per-bullet acceptance not run. |
| 185 | support codex rollback after app-server restart | Gap | Codex transport does not expose the selected-turn rollback operation claimed here. |
| 186 | correct codex native and nested subagent mapping | Have | Codex native-child mapping and parent-broker approvals are covered by passing focused tests. |
| 187 | route codex child approvals to parents | Have | Codex native-child mapping and parent-broker approvals are covered by passing focused tests. |
| 188 | track codex background completions and resumed children | Partial | Codex app-server transport/recovery/translation surfaces exist; startup-stop and child tests pass, full per-bullet acceptance not run. |
| 189 | fix codex startup-stop races and stuck waiting states | Partial | Codex app-server transport/recovery/translation surfaces exist; startup-stop and child tests pass, full per-bullet acceptance not run. |
| 190 | preserve codex reasoning and tool timestamps | Partial | Codex app-server transport/recovery/translation surfaces exist; startup-stop and child tests pass, full per-bullet acceptance not run. |
| 191 | restore codex todos and actionable plans in v2 | Partial | Codex app-server transport/recovery/translation surfaces exist; startup-stop and child tests pass, full per-bullet acceptance not run. |
| 192 | honor codex launch arguments | Partial | Codex app-server transport/recovery/translation surfaces exist; startup-stop and child tests pass, full per-bullet acceptance not run. |
| 193 | port codex feedback and managed authentication to v2 | Verify | Managed auth/feedback/sign-out recovery need their specific login flow; no conclusion from transport tests. |
| 194 | fix codex interrupted sign-out recovery | Verify | Managed auth/feedback/sign-out recovery need their specific login flow; no conclusion from transport tests. |
| 195 | remove unsupported grok auto-accept-edits mode | Different | No dedicated native Grok/Antigravity chat transport in the registry. Generic ACP and terminal status hooks are separate concerns. |
| 196 | ask about grok classifier-rejected commands | Different | No dedicated native Grok/Antigravity chat transport in the registry. Generic ACP and terminal status hooks are separate concerns. |
| 197 | correct grok approval scopes | Different | No dedicated native Grok/Antigravity chat transport in the registry. Generic ACP and terminal status hooks are separate concerns. |
| 198 | show grok api failures instead of empty success | Different | No dedicated native Grok/Antigravity chat transport in the registry. Generic ACP and terminal status hooks are separate concerns. |
| 199 | track grok background replies as continuation runs | Different | No dedicated native Grok/Antigravity chat transport in the registry. Generic ACP and terminal status hooks are separate concerns. |
| 200 | share antigravity account authentication across clients | Different | No dedicated native Grok/Antigravity chat transport in the registry. Generic ACP and terminal status hooks are separate concerns. |
| 201 | send antigravity images directly and other attachments as file paths | Different | No dedicated native Grok/Antigravity chat transport in the registry. Generic ACP and terminal status hooks are separate concerns. |
| 202 | replace browser-owned queues with durable server queues | Have | Durable SQLite queue and ordered dispatch/restart tests pass, including current uncommitted queue improvements. |
| 203 | preserve queue order across restarts | Have | Durable SQLite queue and ordered dispatch/restart tests pass, including current uncommitted queue improvements. |
| 204 | hold restarted queues for explicit resume | Different | Current policy auto-drains eligible persisted entries; only explicitly held entries stay held after restart. |
| 205 | preserve queues through usage limits | Verify | Need limit/late-steering integration cases. Unknown delivery outcomes deliberately stay ineligible, not blindly resent. |
| 206 | edit, reorder, remove and steer queued messages | Partial | Edit/remove/hold/release/steer controls exist; no reorder action in the queue contract. |
| 207 | show queue previews and attachment thumbnails | Partial | Text and filenames render in queue bubbles; image thumbnail parity is not present in that component. |
| 208 | retain generic files during queue edits | Bug | B5: edit hydrates text only and replacement drops original attachment parts. |
| 209 | add/remove attachments while editing | Bug | B5: edit hydrates text only and replacement drops original attachment parts. |
| 210 | keep queue edits pending until saved | Partial | beginEdit durably holds the row until replacement/release, but B7 violates the conflict-save path. |
| 211 | restore previous composer drafts after queue editing | Bug | B6: ordinary composer draft is overwritten and not restored on cancel/save. |
| 212 | handle queue entries changed by another client | Bug | B7: failed replacement falls through to a fresh send instead of staying a conflict. |
| 213 | stop held queues falsely showing working | Partial | Held status and separate child-wake owner exist; exact sidebar/queue-only rendering needs live verification. |
| 214 | hide internal wake deliveries from user queues | Partial | Held status and separate child-wake owner exist; exact sidebar/queue-only rendering needs live verification. |
| 215 | run limit recovery before queued follow-ups | Verify | Need limit/late-steering integration cases. Unknown delivery outcomes deliberately stay ineligible, not blindly resent. |
| 216 | recover late steering as follow-up work | Verify | Need limit/late-steering integration cases. Unknown delivery outcomes deliberately stay ineligible, not blindly resent. |
| 217 | add shortcuts for alternate send, queued steering and queue editing | Verify | Shortcut/remapping/mobile send preferences need their actual UI/keybinding inventory and flows. |
| 218 | add a background-thread/new-composer shortcut | Verify | Shortcut/remapping/mobile send preferences need their actual UI/keybinding inventory and flows. |
| 219 | make new shortcuts remappable | Verify | Shortcut/remapping/mobile send preferences need their actual UI/keybinding inventory and flows. |
| 220 | add mobile queue editing and reordering | Partial | Shared responsive queue edit controls exist; reorder action is missing and edit defects also affect this path. |
| 221 | expose mobile queue/steer preferences and alternate send | Verify | Shortcut/remapping/mobile send preferences need their actual UI/keybinding inventory and flows. |
| 222 | track whether approvals/questions remain answerable | Have | Live request ownership/expiry, persisted answers, pending controls and child routing have canonical broker owners; UI parity not all exercised. |
| 223 | disable dead-process approval actions | Have | Live request ownership/expiry, persisted answers, pending controls and child routing have canonical broker owners; UI parity not all exercised. |
| 224 | distinguish blocking and asynchronous questions | Partial | Broker binds requests to start/turn/child lifetimes. A separate post-provider-exit asynchronous question contract is not established. |
| 225 | allow asynchronous answers after provider exit | Partial | Broker binds requests to start/turn/child lifetimes. A separate post-provider-exit asynchronous question contract is not established. |
| 226 | retain answers on question timeline items | Have | Live request ownership/expiry, persisted answers, pending controls and child routing have canonical broker owners; UI parity not all exercised. |
| 227 | remove answered questions from pending controls | Have | Live request ownership/expiry, persisted answers, pending controls and child routing have canonical broker owners; UI parity not all exercised. |
| 228 | preserve select/multiselect semantics across clients | Have | Live request ownership/expiry, persisted answers, pending controls and child routing have canonical broker owners; UI parity not all exercised. |
| 229 | hide disallowed custom-answer inputs | Verify | Custom-answer/approval-priority/mobile-stop layout requires explicit request/UI scenarios. |
| 230 | route native-child requests to parents | Have | Live request ownership/expiry, persisted answers, pending controls and child routing have canonical broker owners; UI parity not all exercised. |
| 231 | prioritize pending approvals over working status | Verify | Custom-answer/approval-priority/mobile-stop layout requires explicit request/UI scenarios. |
| 232 | keep mobile stop controls accessible above questions | Verify | Custom-answer/approval-priority/mobile-stop layout requires explicit request/UI scenarios. |
| 233 | expire dead callbacks without discarding all asynchronous questions | Partial | Broker binds requests to start/turn/child lifetimes. A separate post-provider-exit asynchronous question contract is not established. |
| 234 | rebuild timelines around stable server-owned items | Have | Server event writer/projection and paged history exist; focused paging tests pass, full stream corpus not rerun. |
| 235 | group multiple provider turns into one logical response | Partial | Logical turn grouping exists in timeline; every multiple-provider-turn/background continuation case needs corpus verification. |
| 236 | preserve streamed-item order | Have | Server event writer/projection and paged history exist; focused paging tests pass, full stream corpus not rerun. |
| 237 | page older history with loading/error states | Have | Server event writer/projection and paged history exist; focused paging tests pass, full stream corpus not rerun. |
| 238 | deduplicate paged and live history | Have | Server event writer/projection and paged history exist; focused paging tests pass, full stream corpus not rerun. |
| 239 | avoid resurrecting hidden history items | Verify | History hiding, cold scrolling, failure counts, background labels and timer anchoring are visual/corpus acceptance gaps. |
| 240 | improve cold-open and queued-run scrolling | Verify | History hiding, cold scrolling, failure counts, background labels and timer anchoring are visual/corpus acceptance gaps. |
| 241 | group work, reasoning and subagents into collapsible sections | Have | Existing timeline/transcript components render groups, queued status, agent authors and tool presentation; not a complete UI acceptance claim. |
| 242 | show handoff, fork, compaction and interruption events | Partial | Handoff/compaction/interruption presentation exists; fork UI/event equivalence is missing. |
| 243 | label queued and steered messages | Have | Existing timeline/transcript components render groups, queued status, agent authors and tool presentation; not a complete UI acceptance claim. |
| 244 | link agent-originated messages to their source | Have | Existing timeline/transcript components render groups, queued status, agent authors and tool presentation; not a complete UI acceptance claim. |
| 245 | summarize meaningful tool actions | Have | Existing timeline/transcript components render groups, queued status, agent authors and tool presentation; not a complete UI acceptance claim. |
| 246 | avoid counting retries/failures as completed work | Verify | History hiding, cold scrolling, failure counts, background labels and timer anchoring are visual/corpus acceptance gaps. |
| 247 | keep stopped commands and failed runs visible | Verify | History hiding, cold scrolling, failure counts, background labels and timer anchoring are visual/corpus acceptance gaps. |
| 248 | identify background completions by task type | Verify | History hiding, cold scrolling, failure counts, background labels and timer anchoring are visual/corpus acceptance gaps. |
| 249 | anchor timers to the correct run | Verify | History hiding, cold scrolling, failure counts, background labels and timer anchoring are visual/corpus acceptance gaps. |
| 250 | freeze settled subagent durations | Verify | History hiding, cold scrolling, failure counts, background labels and timer anchoring are visual/corpus acceptance gaps. |
| 251 | remove legacy token-by-token streaming settings | Different | T3 legacy streaming-setting removal is a migration detail, not evidence of a Claxedo defect. |
| 252 | show command metadata and diff navigation rather than raw tool-output bodies | Have | Existing timeline/transcript components render groups, queued status, agent authors and tool presentation; not a complete UI acceptance claim. |
| 253 | make lineage durable and navigable | Partial | Durable subagent bindings and inline/panel views exist; exact per-run model/result/history completeness is not proven. |
| 254 | show child models, status, progress, results and duration | Partial | Durable subagent bindings and inline/panel views exist; exact per-run model/result/history completeness is not proven. |
| 255 | stabilize lineage ordering and parent status | Bug | B4 causes stale terminal child status and missing later wakes; other ordering cases need corpus acceptance. |
| 256 | group current/previous children and retain failures | Partial | Durable subagent bindings and inline/panel views exist; exact per-run model/result/history completeness is not proven. |
| 257 | page large lineage lists | Gap | Current child listing returns the children as a whole; no cursor/page contract in inspected listSubagents/tool surface. |
| 258 | add collapsible multi-subagent cards | Partial | Durable subagent bindings and inline/panel views exist; exact per-run model/result/history completeness is not proven. |
| 259 | add a mobile agents sheet | Verify | Mobile agents sheet, sidebar filtering and notification suppression require actual navigation/notification acceptance. |
| 260 | replace native-child composers with status and open-parent controls | Have | SessionScreen suppresses composer for owned child views and renders ChildNotice/open-parent behavior. |
| 261 | filter native children from ordinary sidebar/search navigation | Verify | Mobile agents sheet, sidebar filtering and notification suppression require actual navigation/notification acceptance. |
| 262 | suppress redundant child completion notifications | Verify | Mobile agents sheet, sidebar filtering and notification suppression require actual navigation/notification acceptance. |
| 263 | replace the separate agents panel with lineage/inline views | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 264 | move workspace/git/script controls into thread details | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 265 | add workspace, version-control, automation and lineage sections | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 266 | show saved project scripts and linked pull requests | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 267 | keep merge controls aligned with current checks | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 268 | adapt thread details between inline/popover layouts | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 269 | coordinate chat, details and preview sizing | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 270 | keep previews from covering the composer where possible | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 271 | expose composer workspace controls with a persistent-display preference | Different | T3 thread-details/panel arrangement is a product layout choice. Claxedo has its own shell, git/worktree controls and panes; layout parity is not automatically required. |
| 272 | add thread references through title search and sidebar drag/drop | Verify | Title-search/drag references and source-opening chips were not established from the inspected surfaces. |
| 273 | make reference chips open source threads | Verify | Title-search/drag references and source-opening chips were not established from the inspected surfaces. |
| 274 | retrieve referenced history on demand | Partial | Agent session_transcript fetches/paginates history with scope checks; reference-chip authorization workflow not established. |
| 275 | separate context occupancy from per-turn usage | Have | Transport usage/context distinction exists; Claude child-metering/context and Codex usage focused tests pass. |
| 276 | preserve usage through incomplete terminal events | Verify | Incomplete terminal/compaction/session-change usage needs dedicated end-to-end observations. |
| 277 | correct usage after compaction and session changes | Verify | Incomplete terminal/compaction/session-change usage needs dedicated end-to-end observations. |
| 278 | add a distinct limited status | Gap | Goal limited state/rate-limit diagnostics exist, but general session snooze/resume-at-reset/scheduled continuation policies are absent from inspected session and Task APIs. |
| 279 | add manual resume and resume-at-reset | Gap | Goal limited state/rate-limit diagnostics exist, but general session snooze/resume-at-reset/scheduled continuation policies are absent from inspected session and Task APIs. |
| 280 | add snooze-until-reset separately from automatic resume | Gap | Goal limited state/rate-limit diagnostics exist, but general session snooze/resume-at-reset/scheduled continuation policies are absent from inspected session and Task APIs. |
| 281 | configure recovery defaults across clients | Gap | Goal limited state/rate-limit diagnostics exist, but general session snooze/resume-at-reset/scheduled continuation policies are absent from inspected session and Task APIs. |
| 282 | recover overdue continuations after restart | Gap | Goal limited state/rate-limit diagnostics exist, but general session snooze/resume-at-reset/scheduled continuation policies are absent from inspected session and Task APIs. |
| 283 | invalidate obsolete continuations after new work/archive/settlement | Gap | Goal limited state/rate-limit diagnostics exist, but general session snooze/resume-at-reset/scheduled continuation policies are absent from inspected session and Task APIs. |
| 284 | avoid inventing reset schedules when timing is unknown | Different | Do not invent reset times. No equivalent reset scheduler was found; preserve unknown timing if adding one. |
| 285 | make stop work during startup | Have | Startup-stop race tests and capability-based individual background-task stop tests pass. |
| 286 | let ui stop reach background work after foreground completion | Have | Startup-stop race tests and capability-based individual background-task stop tests pass. |
| 287 | avoid useless stop controls in queue-only states | Partial | Queue states, fenced recovery and reconciliation exist; exact UI controls/agent death notices require acceptance. |
| 288 | reconcile stale runs and children after restart | Partial | Queue states, fenced recovery and reconciliation exist; exact UI controls/agent death notices require acceptance. |
| 289 | tell agents which background work died | Partial | Queue states, fenced recovery and reconciliation exist; exact UI controls/agent death notices require acceptance. |
| 290 | preserve model/options in eligible restart continuations | Gap | No equivalent eligible-settled-thread automatic restart continuation policy established in current session API. |
| 291 | recover eligible settled threads that lost background work | Gap | No equivalent eligible-settled-thread automatic restart continuation policy established in current session API. |
| 292 | attribute background replies to their own continuation runs | Have | Claude idle native continuation delivery exists and its focused test passes; not a guarantee across every provider. |
| 293 | let persistent dev servers coexist with completion alerts | Verify | Long-lived server coexistence with completion notifications needs a real process/UI flow. |
| 294 | bind checkpoints and diffs to v2 runs | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 295 | correct repeated rollback boundaries | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 296 | include failed/interrupted/cancelled runs in rewind handling | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 297 | fix edit-from-here after stopped runs | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 298 | surface rollback failures instead of hanging | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 299 | reject unsafe checkpoint restores | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 300 | preserve conversation-only rewind | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 301 | check worktree overlap, nested paths and symlinks before file restore | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 302 | include archived threads in workspace-safety checks | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 303 | avoid confusing shared provider directories with thread workspaces | Different | T3 per-run rewind/checkpoint workflow is not implemented as the same Claxedo contract. Workspace checkpoint/restore tools exist and require their own safety audit; this is not a restore-safety clearance. |
| 304 | preserve task-step timing across restarts | Partial | Task/session records have durable timing fields; T3-style scheduled step lifecycle semantics are not established. |
| 305 | add scheduled-task settings across web/mobile | Gap | Native Task CRUD/start exists; scheduled-automation CRUD and timezone/mobile schedule settings are not in inspected live Task contracts. |
| 306 | create, edit, pause, resume, run and delete automations | Gap | Native Task CRUD/start exists; scheduled-automation CRUD and timezone/mobile schedule settings are not in inspected live Task contracts. |
| 307 | filter automations by project/environment | Gap | Native Task CRUD/start exists; scheduled-automation CRUD and timezone/mobile schedule settings are not in inspected live Task contracts. |
| 308 | use execution-environment timezones for fixed schedules | Gap | Native Task CRUD/start exists; scheduled-automation CRUD and timezone/mobile schedule settings are not in inspected live Task contracts. |
| 309 | validate mobile schedules and warn about unsaved edits | Gap | Native Task CRUD/start exists; scheduled-automation CRUD and timezone/mobile schedule settings are not in inspected live Task contracts. |
| 310 | configure static, generated or custom worktree branch names | Verify | Worktree creation exists; branch naming configuration/failure retention needs worktree-specific tests. |
| 311 | allow project branch-naming overrides | Verify | Worktree creation exists; branch naming configuration/failure retention needs worktree-specific tests. |
| 312 | retain temporary branches when generated names fail | Verify | Worktree creation exists; branch naming configuration/failure retention needs worktree-specific tests. |
| 313 | derive sidebar status from actual runtime state | Have | Session-list store derives from server status/metadata events and reconciles reads against event timing. |
| 314 | distinguish working, waiting, limited and failed | Partial | Working/waiting/failure facts exist; distinct general session limited status and reset recovery are not equivalent. |
| 315 | stop waiting timers growing like active-work timers | Verify | Timer/failure precedence/read sync/title duplication/archive eligibility/sidebar churn need targeted races and live UI checks. |
| 316 | preserve failures despite pending background work | Verify | Timer/failure precedence/read sync/title duplication/archive eligibility/sidebar churn need targeted races and live UI checks. |
| 317 | avoid hiding active work behind newer queued/cancelled runs | Verify | Timer/failure precedence/read sync/title duplication/archive eligibility/sidebar churn need targeted races and live UI checks. |
| 318 | synchronize visit/read state where supported | Verify | Timer/failure precedence/read sync/title duplication/archive eligibility/sidebar churn need targeted races and live UI checks. |
| 319 | propagate metadata changes across clients | Have | Session-list store derives from server status/metadata events and reconciles reads against event timing. |
| 320 | prevent duplicate title regeneration | Verify | Timer/failure precedence/read sync/title duplication/archive eligibility/sidebar churn need targeted races and live UI checks. |
| 321 | make settlement server-owned | Different | T3 settlement rules involving pins and PRs are a product lifecycle choice; do not equate ordinary turn finalization with that feature. |
| 322 | account for linked prs, pins and background work in settlement | Different | T3 settlement rules involving pins and PRs are a product lifecycle choice; do not equate ordinary turn finalization with that feature. |
| 323 | use actual activity for mobile archive eligibility | Verify | Timer/failure precedence/read sync/title duplication/archive eligibility/sidebar churn need targeted races and live UI checks. |
| 324 | reduce sidebar churn from hidden child output | Verify | Timer/failure precedence/read sync/title duplication/archive eligibility/sidebar churn need targeted races and live UI checks. |
| 325 | bound snapshots and page long conversations | Partial | Paged transcript/store, bounded caches and coalesced event architecture exist; no performance benchmark or all-size acceptance was run. |
| 326 | reduce transcript decoding and retained memory | Partial | Paged transcript/store, bounded caches and coalesced event architecture exist; no performance benchmark or all-size acceptance was run. |
| 327 | coalesce streaming updates and narrow subscriptions | Partial | Paged transcript/store, bounded caches and coalesced event architecture exist; no performance benchmark or all-size acceptance was run. |
| 328 | reduce unrelated rerenders and settled-agent timer work | Partial | Paged transcript/store, bounded caches and coalesced event architecture exist; no performance benchmark or all-size acceptance was run. |
| 329 | improve mobile scrolling, anchoring and overlay bounds | Verify | Phone scrolling/overlay bounds and persisted client cache behavior require packaged/browser acceptance. |
| 330 | persist v2 client caches | Verify | Phone scrolling/overlay bounds and persisted client cache behavior require packaged/browser acceptance. |
| 331 | tolerate unknown compatible event types | Have | Unknown provider events have bounded diagnostics; strict capability contracts still apply. |
| 332 | migrate once into a separate v2 database | Different | T3 v2 database/profile/import migration specifics do not transfer directly. Claxedo migration/resume integrity still needs its own validation. |
| 333 | keep settings, attachments and workspace files shared | Different | T3 v2 database/profile/import migration specifics do not transfer directly. Claxedo migration/resume integrity still needs its own validation. |
| 334 | use a separate desktop browser profile | Different | T3 v2 database/profile/import migration specifics do not transfer directly. Claxedo migration/resume integrity still needs its own validation. |
| 335 | import old messages and metadata without promising full runtime-history migration | Different | T3 v2 database/profile/import migration specifics do not transfer directly. Claxedo migration/resume integrity still needs its own validation. |
| 336 | resume imported threads through fresh sessions and portable context | Different | T3 v2 database/profile/import migration specifics do not transfer directly. Claxedo migration/resume integrity still needs its own validation. |
| 337 | load large imported transcripts progressively | Different | T3 v2 database/profile/import migration specifics do not transfer directly. Claxedo migration/resume integrity still needs its own validation. |
| 338 | reject incompatible client/server versions with update guidance | Verify | Compatible client/server version rejection was not established by this review; harness version gates are not the same contract. |
| 339 | require compatible native mobile builds for native changes | Different | T3 native-mobile build compatibility is not the same as Claxedo's shared responsive web/desktop client. |
