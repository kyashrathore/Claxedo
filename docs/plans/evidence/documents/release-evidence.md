# Documents Core Release Evidence

Date: 2026-07-17

This record is the final execution evidence for
`docs/plans/2026-07-16-001-feat-documents-core-implementation-plan.md`.
Commands ran from the named package directory unless stated otherwise.

## Human editor release gate

- Full real-backend browser journey:
  `CLAXEDO_E2E_SUITE=all CLAXEDO_E2E_LIVE=1 CLAXEDO_E2E_LIVE_BACKEND_PORT=3301 VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3301 PLAYWRIGHT_VIDEO=1 npx playwright test --config playwright.config.ts e2e/playwright/live-documents-core.spec.ts --workers=1 --retries=0`
  — **5 passed in 52.2s**.
- Headed mock release canary:
  `CLAXEDO_E2E_SUITE=core PLAYWRIGHT_VIDEO=0 npx playwright test --config playwright.config.ts e2e/playwright/documents-core.spec.ts --grep @documents-release-canary --workers=1 --retries=0 --headed`
  — **3 passed in 26.3s**. The visible browser typed and pasted through autosave, applied formatting and slash actions through autosave, and opened `/docs` in unsigned local mode.
- Headed real-filesystem rich canary:
  `CLAXEDO_E2E_SUITE=all CLAXEDO_E2E_LIVE=1 CLAXEDO_E2E_LIVE_BACKEND_PORT=3301 VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3301 PLAYWRIGHT_VIDEO=0 npx playwright test --config playwright.config.ts e2e/playwright/live-documents-core.spec.ts --grep @documents-rich-live-canary --workers=1 --retries=0 --headed`
  — **1 passed in 24.4s**.
- Full mock browser matrix — **11 passed**. Retained under `mock-browser/`.
- Retained live videos and state screenshots are under `live-browser/`. They prove rich typing/autosave/reopen, a full server restart, clean external refresh, dirty conflict, version restore, `/docs` grant, a shell edit through the granted session path, parked stale-base write-back, continued human editing, and repository-file deletion recovery.

The picker regression is covered by 9 focused tests. One test changes the draft identity while `openDocument` is in flight and proves the mention is still inserted for the same real session; another proves newer typing is preserved and the opening notice is cleared.

## Package gates

- `packages/claxedo-app: bun typecheck` — exit 0; theme gate green, **165 architecture tests**, app build/typecheck, **4 performance Bun tests**, and **23 performance Vitest tests** passed.
- `packages/claxedo-server: bun typecheck` — exit 0.
- `packages/claxedo-server: bun x vitest run src/routes/documents.test.ts src/workspace-runtime-integration/session-env-document-roundtrip.integration.test.ts` — **28 passed**.
- Final-cycle server Documents matrix — **24 files / 278 tests passed**, followed by the focused 28-test rerun after the local-project identity fix.
- Documents legacy/staleness guard — **2 passed**; the guard covers TypeScript, TSX, and CSS retired surfaces.
- Focused app Documents matrix — **169 Bun tests and 9 Vitest tests passed** before the final picker change; the changed picker/selection files were then rerun and passed **9/9**, followed by the package typecheck and headed browser gates above.
- `git diff --check` — clean.

## Exact-byte and runtime evidence

- Real session tool smoke:
  `bun run smoke:documents-session`
  — exit 0, `exactBytes:true`, `hydratedDocuments:1`, `disposed:true`, before SHA-256 `08d19e30bbe3018ef16960b7cb0583375c6458fd4b13f5f9df3c4d9d019cf500`, after SHA-256 `266b5bdca666fcd577e3d2d4077b7cd4c709fa8b8f5472736c5f04a0363fcc86`.
- Live relay cloud-client smoke — read `before cloud VM relay`, advanced the write version, rejected stale CAS with HTTP 409, and left canonical SHA-256 `05bb94017c7154e12ac5cca128d8cbd5f81332f13adf433a1baa15bdbc029e14` (25 bytes).
- Authenticated staged Cloudflare R2 smoke against `claxedo-documents-staging` — exact first/final bytes, distinct create/update versions, stale CAS rejected, two snapshots, final SHA-256 `24ade5113d40b3f14cd3685307cd50b098af6780947acfa8e1cc863444030cd8`.
- Standard unsigned server smoke — `/documents` returned 200 without auth, retired `/pages` returned 404, create/read/CAS-write/list passed, and list rows remained metadata-only.

An independent final D12 review found no security or placement blockers. It verified that capabilities bind principal, organization, project, both workspace identities, session, document, operation, JTI, audience/issuer, token expiry, and job expiry; negative tests cover scope escalation, expiry, revocation, untrusted/unreachable transport, viewer denial, and stale CAS; and installation credentials remain local to the broker and absent from session execution, hydrated files, manifests, and responses.

## Markdown fidelity

The detector and production editor share `richDocumentExtensions`. Exact production `MarkdownManager` round trips cover all supported fixtures and every rich-admitted repository document. Current corpus: 61 files; 2 rich, 59 source; 31 byte mismatches, 28 unsupported constructs, 0 rejected inputs. Source mode remains the lossless fallback.

## Retained artifacts

- `mock-browser/`: 11 mock journeys, 20 state screenshots, and 11 recordings.
- `live-browser/`: five real-backend journeys, 11 state screenshots, and five recordings.
- `visual-verdict.md`: separate visual review and artifact-level verdict.
