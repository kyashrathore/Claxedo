# Staging integration review

Candidate branch: `fix/staging-integration`, based on local `dev` at
`a6de1c8a73`, with the completed sandbox, Linux unit, harness modularization,
and lint repair branches merged. The unfinished `harness-budget` worktree
has not been imported.

## Domain budgets

These are aggregate ownership budgets, separate from the per-file and
per-function limits. The harness checker explicitly permits a reviewed domain
budget. No file-size limit increases. The harness's 300-line file and 40-line
function limits still apply; the app's total remains 94,000 lines. Reviewed
domains are set to their measured count with no headroom.

The harness budget last changed at `a38ffcccd7`. Since then, translator
monoliths have been split into specific protocol owners, and native session
lifecycle support has grown. Forcing the old aggregate counts by recombining
these modules would undo the file-size repairs.

| Harness domain | Before → measured | Reviewed owners |
| --- | --- | --- |
| Profiles | 600 → 656 | `config-mirror.ts` owns atomic mirroring and external-skill containment; `pi/mcp.ts` owns literal MCP values; Codex home composition preserves resumable owner state. |
| Translation | 550 → 555 | `frame-excerpt.ts` owns bounded diagnostic excerpts; attachment readers preserve the supplied bytes. |
| ACP | 3014 → 3110 | Tool facts, updates, presentation, content chunks, configuration options and plan updates now have separate translator modules. `wire-updates.ts` owns session update delivery and `children.ts` child continuity. |
| Claude | 2969 → 3387 | Separate message, tool-result, usage and subagent translators replace the old combined translator. `live-query.ts` owns query lifetime; `live-settings.ts` applies model, effort and permission changes through the SDK. |
| Codex | 2793 → 3060 | `children.ts` owns native child state; `native-children.ts` interprets provider observations; `child-delivery.ts` orders delivery. Session and usage owners remain transport-specific. Generated protocol declarations remain excluded by the existing checker. |
| Cursor | 1652 → 1872 | `cancel.ts` owns deadline-bound cancellation; host deltas and task/shell translators carry SDK events that its ordinary stream omits. These differ from Codex and Claude lifecycle protocols. |
| Pi | 864 → 1411 | `session-stream.ts` owns the explicit idle/turn/provider state; `provider-turn.ts` admits Pi-initiated runs; `run.ts` handles terminal delivery; `steers.ts` correlates incorporation. Native MCP handoff and version admission have dedicated owners. |

The app comparison uses `c78f8fb178`, the last app budget edit. The affected
increments are local validation and exhaustiveness repairs, not a new domain.

| App domain | Before → measured | Reviewed change |
| --- | --- | --- |
| Shell/platform | 6628 → 6629 | Registry state erasure and JSON checks have named owners in `pane-kind-entry.tsx` and `json.ts`, offset by removed duplicate code. |
| Terminal | 4300 → 4304 | Hex-color validation and typed terminal boundaries replace assertions. |
| Review/files | 4344 → 4352 | `intent.ts` and `review-tab.tsx` explicitly reject impossible selection variants. |
| Plugin host | 2070 → 2083 | Bundle and dictionary validation, manifest rendering and the pane-registration type boundary. |
| Web plugin frame | 864 → 917 | `protocol.ts` validates mention replies, response headers and session references at the frame boundary. |
| Marketplace | 2399 → 2402 | Invalid source input exits explicitly and view handlers preserve their declared return type. |

## Narrow lint boundaries

Most lint repairs changed source. The remaining explicit exceptions preserve
contracts the rule cannot express:

- Playwright requires destructured fixture arguments; an empty pattern names
  no dependencies. Four fixture declarations carry only that rule directive.
- Identifier brands have no runtime representation. The existing brand-mint
  exception also names the app's dedicated `server/ids.ts` owner.
- `operationInput` decodes every field before the mapped result assertion.
- Cloudflare and DOM libraries declare different Request/Response types for
  the same runtime classes. Directives sit only on the three bridge lines;
  streams are not reconstructed to satisfy TypeScript.
- Plugin pane kinds erase their registered live state type. The one restoring
  assertion remains at dispatch, documented in the plugin owner's README.

Plugin operations now return `unknown` rather than promising an unchecked
caller-selected type. This is a TypeScript API change; plugins that supplied
a result type argument must validate their returned value. Runtime operation
names, payloads, manifest checks and responses are unchanged.

Stored latest-turn pages validate complete canonical agent messages before
entering the typed first-page flow. Malformed snapshots fail explicitly; no
messages or fields are synthesized or silently removed.

## Deployment status

Validation is ongoing. This document is not deployment approval or a claim
that staging acceptance has passed. Remote `dev` and `staging` were both at
`c8a1d691f1` when inspected. This session has made no Cloudflare mutations.

## Translator corpus repair

The full harness run passed 1,633 cases and failed five recordings that still
expected shell command text synthesized as `description`. Commit
`d21804fe24` deliberately removed that synthesis and already tests that it is
absent. The corpus repair removes only those identical command/description
pairs from expected outputs and carried state in the five failing recordings.
Raw provider events, callback recordings and all other expectations stay intact.
The complete translator corpus passes after this repair.

Cloudflare's complete D1 inventory (three databases) contains neither configured
staging database name. The existing staging Worker still binds their old IDs.
The next deployment will resolve/create by name; this session has deleted no
resources. Existing Worker secret *names* were checked without retrieving values.

## Verification evidence

Local logs are `/private/tmp/staging-integration-*.log`.

| Command | Result |
| --- | --- |
| `bun run lint` | 0 warnings, 0 errors |
| `bun run build:packages` | 14/14 packages |
| `bun run typecheck` | 29/29 packages |
| `bun run test:ci-policy` | Passed |
| `bun run test:architecture-ratchets` | Passed; six product source policies, helper and file-size ratchets |
| App `bun run check` | 20/20 checks |
| Harness `bun run check` | Passed |
| App `bun run test` | 483 passed |
| Server `bun run test` | 2,448 main tests and 32 registry tests passed |
| Server-core `bun run test src/session/latest-view-page.test.ts` | 5 admission cases passed |
| Harness `bun test src scripts e2e/harness` | 1,633 passed, five stale corpus failures subsequently repaired |
| Harness `bun test src/conformance/translate/corpus.test.ts` | All 30 passed after the targeted expectation repair |
| Harness `bun run test:node` | 10 passed |
| App `bun run e2e 30-transcript-corpus.spec.ts --project=web --project=phone` | 50 passed; two stale subagent snapshots differed only by the existing background-mode label from `e67959eef3` |
| Same E2E command with `--grep=subagent-chip` | Both passed after inspected baseline refresh, without update mode |
| Clean Ubuntu Codex conformance | 86 passed, including successful command cancellation and failed goal-command admission |
| Desktop `bun run verify:closure` | Complete build and emitted/source closure checks passed |
| Server `bun run sandbox:image --agent-plugins` | Local Linux image build and in-image runtime smoke passed; no push |
| Control-plane and relay staging dry runs | Both bundled offline; no deploy |

The full clean Linux unit umbrella and the Cloudflare-specific Dockerfile
build are still running. Native Windows and packaged desktop acceptance have
not been run for this integration. Live staging flows have not been exercised.
