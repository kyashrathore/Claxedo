# Live model and effort changes

Model and effort selections reach supported running harnesses without interrupting the turn, replacing its prompt, restarting its process, or stopping background work. An in-flight model request keeps its captured settings; the next request in the same turn uses the accepted selection. Cursor's SDK has no live model setter, so its selection remains a next-turn change.

For an open session, picking a model or an effort in the composer calls `PATCH /session/:id/config` at once: the model pick sends `{ model }` and the effort pick sends `{ variant }` (`null` for the default). The composer sends one session's model writes, effort writes and submission write (`commitSessionSelection`) one at a time, in the order they were made (`harness-model-writer.ts`), and a submission waits for the earlier writes to settle. A refused write restores the selection the server last confirmed and raises a "Request failed" toast with the refusal. A draft keeps its picks locally until the session is created.

`sessionConfigWrite` owns authorization, immutable-field validation, normalization and configuration refusal responses. `createSessionLifecycle.updateSessionConfig` runs one config write per session at a time, so a slow native control cannot let a second write read stale config and revert the first. `applyModelSettings` (`packages/session-core/src/host/model-settings.ts`) applies the proposal to the current runtime config and calls the transport's optional `config.setModelSettings` before persisting it. A model change that names no effort keeps the saved effort only when the new model's `thought_level` option offers it; otherwise the effort resets to the harness default, so a model-only write never forwards an effort chosen for the old model. The control receives the model the next turn would run (`resolveSessionModel`), so a model reset reaches the harness as its resolved default. A refused update returns HTTP 409 with `session_config_refused`; the saved selection remains unchanged and the active turn remains usable. Unchanged selections send no control. Model and effort clearing is persisted as explicit `null`, as required by the store's partial-update contract.

ACP keeps its existing authoritative `harnessConfig.update` path. The runtime never invokes a second model setter on a harness that owns that path.

| Harness | Native update | Application boundary |
| --- | --- | --- |
| Claude SDK | One `applyFlagSettings` containing model and effort | Next model request in the live query |
| Codex app-server | Experimental `turn/settings/update`; `thread/settings/update` for future turns | Next request in the active native turn; future native turns retain the choice |
| Pi RPC | `set_model`, `set_thinking_level` | Next agent model request |
| OpenCode SDK | Existing session port's `switchModel`, including its variant | Next engine step |
| ACP | Existing `session/set_config_option` | Accepted during the active prompt; peer owns the model boundary |
| Cursor SDK | Existing selection on send | Next user turn |

Claude serializes model controls with permission controls and waits for a launching query to open. A refused combined control leaves its live settings snapshot unchanged. Effort reset sends `effortLevel: null`.

Codex enables `step_model_switching` on the thread. It validates model and effort through native `model/list` before sending any control and supplies the reported model default when effort is cleared: native `null` means leave the current effort unchanged. The turn-level update goes first because it is the control Codex refuses for live model changes that alter admitted tool requirements; the client preserves that rejection. A target that completed during the update reports `targetUnavailable`, and a turn whose start failed is skipped; either way the accepted future thread selection is queued. Model controls leave speed, summary and permission fields alone.

Pi validates the model and the thinking level on a separate catalog probe before touching the active session, so a rejected level cannot clamp the active session's effort. A cleared effort applies the level a fresh Pi runs that model at, because Pi has no control that removes an explicit level, and a change without a concrete `provider/model` key is refused. A live change and a starting turn's own configuration take the session RPC one at a time. OpenCode validates provider availability and the selected model's advertised variants before calling the session port, and refuses a change that names no model.

## Acceptance evidence

The targeted initial H10 run failed because Claude's second request still used its initial model. The implemented flow holds a real CLI's opening request at the scripted model server, changes settings through the public HTTP endpoint, releases the response, and verifies the original turn's next request. It also verifies effort-only changes, duplicate selections, explicit effort reset, refusal persistence and recovery on the same active turn.

Commands run from `packages/harness` with `PATH=/Users/yashvardhansingh/.bun/bin:$PATH`:

- `bun run flows H10.live-model-settings H10-config-timing`: passed. Covers both live settings and the existing permission/configuration flows.
- `CLAXEDO_E2E_CODEX=min CLAXEDO_E2E_PORT_RANGE=46500-46599 bun run flows H10.live-model-settings`: passed against Codex 0.156.1.
- `CLAXEDO_E2E_CLAUDE=min CLAXEDO_E2E_CODEX=min CLAXEDO_E2E_PORT_RANGE=46500-46599 bun run flows H10.live-model-settings`: passed against Claude Code 2.1.280 and Codex 0.156.1. Default runs used Claude Code 2.1.285 and Codex 0.159.2.
- `bun test src/conformance/pi.test.ts -t 'Pi changes model and effort'`: passed against Pi 1.0.0 in the concurrent working tree.
- `CLAXEDO_E2E_PI=min bun test src/conformance/pi.test.ts -t 'Pi changes model and effort'`: passed against Pi 0.99.0.
- `bun test src/conformance/opencode.test.ts -t 'OpenCode applies model and effort'`: passed against the real embedded engine.
- `bun test src/conformance/acp.test.ts -t 'ACP changes model and effort'`: passed against the scripted ACP parity agent holding its original prompt. No cancel or replacement prompt was sent.
- `bun test src/conformance/codex-background-config.test.ts`: two tests passed, including a real background shell finishing after the model change and a canonical `thread/settings/updated` notification retaining model and effort.
- `bun test src/conformance/claude-background.test.ts`: a real background shell and subsequent turns retain the original process across a live model/effort control, and the CLI's own background-completion request runs the model and effort that control set.
- `bun test src/transports/claude-sdk src/transports/codex-app-server src/transports/pi-rpc src/transports/opencode-sdk`: 523 tests passed before the final two control-ordering tests were added.
- `bun test src/transports/codex-app-server src/transports/claude-sdk src/transports/opencode-sdk/session-config.test.ts`: 403 tests passed after the final controls and refusal recovery tests.
- `bun run typecheck`: passed, including generated experimental Codex types and E2E TypeScript.
- `bun run test:node`: build passed and all 10 plain Node public-entrypoint tests passed.

Commands run from `packages/session-core`:

- `bun test src/host`: 160 tests passed, including acknowledgement-before-persistence, refusal recovery, clearing and the single ACP configuration owner.
- `bun test src/routes/session-core.test.ts src/routes/session-core.routes.test.ts`: 125 tests passed after extracting the config write route.
- `bun run typecheck`: passed.

Model-only writes, write ordering, resets and the composer effort write:

- `packages/session-core`: `bun test src/host/model-settings.test.ts` covers a model-only change keeping an offered effort, dropping one the new model lacks, and two overlapping writes applying in order; `bun test src/host` passed 163 tests.
- `packages/harness`: `bun test src/transports/pi-rpc/live-settings.test.ts` covers a live Pi change and a starting turn taking the RPC one at a time, validation before any session control, and an effort reset; `src/transports/codex-app-server/live-model-settings.test.ts` covers a failed turn start; `bun test src/transports/claude-sdk src/transports/codex-app-server src/transports/pi-rpc src/transports/opencode-sdk` passed 529 tests; `bun run flows H10.live-model-settings` passed for Claude and Codex with a model-only PATCH.
- `packages/claxedo-app`: `bun run e2e -- e2e/flows/06-effort-picker.spec.ts --project=web` passed and asserts the picked effort is persisted before the send.

## Repository checks

`bun script/product-boundary/verify.ts --all --source-only` passed all six product policies after the import changes. The configuration write route was extracted as its own responsibility; the main session route's reviewed file ceiling was lowered from 1899 to 1866.

`bun run check` still fails six existing domain budgets: profiles, ACP, Claude, Codex, Cursor and Pi. All other harness checks pass. The separate `fix/harness-budget-review` lane owns the budget remediation; finish that lane and rerun the command. No domain ceiling was raised here.

`bun run test:architecture-ratchets` passed its 26 tests, source product boundaries and helpers checks in both the shared working tree and the isolated `dev` worktree, then found the existing generated `packages/workspace-relay/bench/reports/dialin-agent.bundle.cjs` over the 800-line source budget (4656 lines). That file is already present in the base commit. The relay benchmark owner must move generated output outside the maintained-source scan or remove its generated artifact and rerun the ratchet. This change leaves the artifact untouched.

The isolated `dev` worktree also passed the public `H10.live-model-settings` flow, harness typecheck and native Pi model/effort acceptance test.
