# Image references without workspace copies

Implemented in the current dirty checkout. This report supersedes the retention design in image-view-live-verification-2026-09-20.md; that earlier report tested a different implementation. Unrelated working-tree changes were preserved.

## Request flow

1. Codex's actual `item/completed` / `imageView` result supplies a path. The Codex adapter emits a `tool-file` attachment on its canonical tool-output. It performs no filesystem read or copy.
2. Client presentation assigns the attachment its normal deterministic ID and persists its original path alongside the tool result. Storage and central message projection carry the existing part structure.
3. ToolImageStrip requests the image through DataProvider.readToolImage. DirectoryScope calls the existing sdk.request transport with session ID, message ID and attachment ID. There is no client-selected filesystem path in the request.
4. GET /session/:id/message/:messageId/attachment/:attachmentId runs message_read authorization, reads the stored messages from the workspace runtime, and resolves only an attachment on a completed assistant tool result with matching identities. It does not start a harness.
5. The runtime opens the recorded original file read-only. It rejects symlinks, directories, non-image signatures, missing files and files above 20 MiB. PNG, JPEG, GIF and WebP are supported. Responses are no-store.
6. The UI creates a temporary browser blob URL. Clicking the thumbnail opens the shared viewer. Unmount aborts pending reads and revokes the URL. Retry repeats only the image request.

The same scoped transport is used for local and hosted requests. A hosted path reference requires the owning machine/runtime to be reachable. Central projection of a path does not upload its bytes.

Claude-provided image bytes stay inline even when the input names a workspace file. Pi and Codex MCP use the existing content-block extractor. ACP now extracts image content and publishes the terminal output after its content, avoiding the prior terminal-status-before-output ordering. Cursor extracts the SDK's MCP image blocks and generated-image bytes. Cursor's installed ReadSuccess schema only exposes text; a filename alone does not manufacture an image attachment.

No new workspace image copies are created. Existing persisted workspace-file records remain readable. Historical attachment-free rows are not rewritten. Original-file deletion makes a tool-file preview unavailable; later original-file modifications may show different pixels.

The existing 128 KiB encoded inline-image limit remains in place. Oversized byte results remain unavailable rather than being silently replaced with a potentially different file or enlarging transcript payloads. This is a remaining coverage limitation, not universal image support.

## Cache and state checks

- The image route has no event publication or persistence writes.
- Tests assert byte-for-byte unchanged message objects after successful reads, deletion, restoration and failed reads.
- Projection tests check stable attachment IDs on replay/snapshot restore and no duplicate terminal part updates.
- UI tests check abort/revoke, late-response rejection, failure/retry recovery and unchanged tool result objects.
- Access tests check session/message/attachment identity, assistant/completed ownership, permission denial before message lookup and unsupported filesystem inputs.

## Live evidence

Source server: http://127.0.0.1:2593. Source UI: http://localhost:4444.
Workspace: 439a5df6-fc4a-4926-882b-f16b4b04ed8a.
Session: b66f2b24-55f6-4a0e-9ed9-d32c2a7ea7f2 (automatically titled Name image probe).
Real Codex call: call_rAKxtscgx6ZJ61hXaAcEexiK.
Message: msg_8af511bd-eedd-4bef-9480-a460ad9c3be6_r.
Attachment: 000001_call_rAKxtscgx6ZJ61hXaAcEexiK-attachment-0.
Original scratch file: /tmp/claxedo-image-reference-probe.png.

- Created the probe through the public session endpoint with nativeHarness=codex, then submitted one bounded native view_image call through prompt_async.
- Session message response contained the tool-file reference and the real provider tool call ID.
- Attachment GET returned 200, image/png, 70 bytes equal to the scratch image.
- Browser showed a thumbnail button. Clicking opened the full-size dialog. DOM inspection confirmed a decoded 1x1 image with a blob URL. Escape closed it.
- Reload preserved the thumbnail.
- Deleted the test scratch file: GET returned 404 and reload showed Retry. Message response remained identical.
- Restored the file and restarted a development process stuck in shutdown: GET again returned 200 and persisted messages remained identical across backend restart.
- Live retry interaction was interrupted by repeated source-server restarts from concurrent edits to store.ts and ACP runtime files, plus a frontend HMR context error. Retry success is covered by the focused mounted UI test; it is not claimed as a completed live-browser acceptance check.

The packaged desktop daemon on port 2594 was not rebuilt/restarted for this version. It still runs the previous implementation. Real hosted-relay and live Claude/Pi/Cursor/ACP/MCP-provider acceptance remain unverified; adapter fixture coverage does not establish those live flows. The next acceptance step is a stable rebuilt runtime and desktop, then the same fresh-call/reload/failure flow through each configured provider and hosted relay.

## Commands and outcomes

From packages/agent-event-runtime:

- `bun test src/harnesses/tool-attachments.test.ts src/harnesses/claude/adapter.test.ts src/harnesses/codex/adapter.test.ts src/harnesses/pi/adapter.test.ts src/harnesses/cursor/adapter.test.ts src/harnesses/acp src/projections/client-presentation/projection.test.ts` — 198 passed.
- After final ACP adjustment, `bun test src/harnesses/acp src/projections/client-presentation/projection.test.ts` — 73 passed.
- `bun run typecheck` — passed.

From packages/agent-sdk-runtime:

- `bun test src/harnesses/codex/workspace-behavior.test.ts` — 26 passed, including the scripted real-driver path with no workspace copy.
- `bun run typecheck` — passed.

From packages/workspace-runtime:

- `bun test src/routes/session-core.test.ts src/routes/tool-image.test.ts` — 83 passed before the final authorization test.
- `bun test src/routes/tool-image.test.ts` — final 4 passed.
- `bun test src/routes/session-core.routes.test.ts` — 4 passed.
- `bun run typecheck` — passed.

From packages/claxedo-app:

- `bun run test:vitest src/features/session/ui/tool-attachments.vitest.tsx src/app/workbench/context/directory-scope.vitest.tsx` — 34 passed before the final retry test.
- `bun run test:vitest src/features/session/ui/tool-attachments.vitest.tsx` — final 10 passed. Existing SVG sprite warning in jsdom.
- `bunx tsgo -b` — passed.
- `bun run typecheck` — blocked in its architecture precheck: route-bridge, message-timeline and session-controller size limits; directory-string/module-state/untrack debt; unjustified cast in bootstrap-global-path.test.ts. These violations are outside the image changes. Baselines were not raised.

From packages/session-ui:

- `bun run typecheck` — passed.

From repository root:

- `git diff --check` — passed.
- `bun run test:architecture-ratchets` — retirement/build checks passed (13); product closure failed app-local 1098 > 1097 and desktop-renderer-unsigned 1141 > 1140. Traced the newly reachable claxedo-tool-href.ts through entry -> runtime-providers -> feature-ports -> directory-scope, an unrelated concurrent change. No ceilings changed.
