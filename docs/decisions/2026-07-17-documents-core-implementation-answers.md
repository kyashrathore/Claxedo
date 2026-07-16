# Documents Core Implementation Answers

## Status

Accepted for the Documents core implementation.

## Decisions

| Question | Decision | Authoritative evidence |
|---|---|---|
| Q1 — rich Markdown fidelity | Rich mode is admitted only after parse/serialize byte comparison against the documented supported subset. Unsupported Markdown remains byte-exact in source mode. | `packages/claxedo-app/src/features/documents/markdown/contract.md`, detector and corpus tests |
| Q2 — local agent file access | Managed documents are materialized one at a time into a contained session-local path and conditionally synchronized back. Repository documents use their canonical workspace path. | `packages/claxedo-server/src/documents/session-hydration.ts`, the real embedded-runtime round-trip integration test |
| Q3 — concurrent local servers | The data directory has one process owner. A second live owner is rejected; stale ownership is reclaimed. Per-document writes additionally use owned heartbeat locks and compare-and-swap. | `packages/claxedo-server/src/data-dir-owner.ts`, `local-managed.test.ts` |
| Q4 — unsigned-local project identity | A normalized local directory maps through the index database’s persistent registry to one generated project identity; symlink aliases resolve to the same record. | `packages/claxedo-server/src/documents/index-store.ts` and its project-identity tests |
| Q5 — frontmatter | Frontmatter is split as an opaque prefix and reattached byte-for-byte. Any form that cannot satisfy the detector stays in source mode. | Markdown contract, frontmatter implementation, adversarial corpus |
| Q6 — changed-on-disk diff | The Documents editor uses the shared text-diff representation with the application’s code styling and compares last-loaded bytes with current bytes. | `packages/claxedo-app/src/features/documents/editor/changed-on-disk-diff.tsx` |
| Q7 — Arena | The legacy Page Arena surface is outside Documents core and has been removed with its routes, storage, UI, and tests. | Persistent legacy-surface guards and the zero-`*page-arena*` staleness gate |
| Q8 — hosted object storage | Hosted managed documents use Cloudflare R2. ETags are opaque versions and `onlyIf` implements create-only and conditional writes. | `2026-07-16-documents-hosted-object-storage.md`, Miniflare contract test, staged real-bucket smoke |
| Q9 — open-document watching | The server watches only open documents, debounces byte changes, and snapshots external boundaries. Watch delivery is advisory; refresh-on-focus/reconnect and save-time CAS remain correctness boundaries. | `packages/claxedo-server/src/documents/watch.ts`, watcher/editor tests |
| Q10 — hosted invalidation | Initial hosted deployment uses process-local SSE fan-out. Clients re-establish truth by content refetch on focus and reconnect, so invalidation loss cannot authorize an overwrite. | Documents backend event coordinator and Documents API reconnect behavior |
| Q11 — size limits | HTTP and storage reject content above 2 MiB. Content above 512 KiB and through 2 MiB opens in source mode. | Markdown contract, detector constants, local/repository/hosted backend tests |
| Q12 — move to repository | The transition is journaled and idempotent: validate, write and verify the repository file, flip the index, then archive the managed source. Recovery preserves at least one complete copy across every crash window. | `packages/claxedo-server/src/documents/move-to-repository.ts` and crash-window tests |
| Q13 — `/docs` composer integration | `/docs` is a native composer picker. A selection carries stable document identity, display name, and an honest resolved path into the normal session prompt. | Composer document-picker controller/selection tests and MCP tool tests |
| Q14 — hydration/write-back owner | The workspace session runtime owns the manifest, debounced watcher, end-of-turn and disposal flushes, capability renewal, and conflict parking. | `2026-07-16-documents-session-writeback.md`, workspace-runtime and session integration tests |
| Q15 — end-to-end proof | Documents journeys live in the consolidated Playwright suite. Every claimed UI state uses geometric hit-testing plus captured screenshots/video, followed by a separate vision verdict. Real-process evidence complements the mock UI matrix. | `packages/claxedo-app/e2e/playwright/documents-core.spec.ts` and the live Documents spec |

## Consequences

Documents have one Markdown authority per origin, one opaque version boundary,
and one conditional synchronization model across local and hosted placement.
Watchers and events improve responsiveness without becoming correctness
authorities. Agent sessions operate on ordinary files and do not introduce a
second document write protocol.
