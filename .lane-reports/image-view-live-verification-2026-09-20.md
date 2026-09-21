# Native Codex image-view verification

A fresh real Codex call passed retention, persistence, session transport, file serving and desktop preview checks on 2026-09-20. No additional production code was changed in this continuation.

## Live evidence

- Desktop daemon PID 97393, started at 14:34:26 local time, serving port 2594. It runs the packaged server under packages/claxedo-desktop/resources/claxedo-server. The current on-disk bundle was rebuilt later; the fresh call below is the evidence for the running process, rather than bundle timestamps.
- Workspace: 634d231e-2979-44e8-95c0-8287490e0a60, directory /Users/yashvardhansingh/test/opencode.
- Session: 4298bf01-ebdd-484b-9888-f985e4068feb, title Fix tool-output text contrast.
- Submitted a bounded image-only probe through POST /workspaces/{workspaceId}/session/{sessionId}/prompt_async. Response: 204. The agent replied "probe complete".
- Real harness call: exec-bfdf44d3-28e6-40b7-92bc-728d77295362, turn 01a0be31-bb48-7d82-9bc1-5d2c95101d50.
- Raw event: item/completed, item.type imageView, path /tmp/claxedo-image-retention-probe.png.
- The journaled completion has tool view_image and a workspace-file attachment at .claxedo/attachments/c414cd0e204d-claxedo-image-retention-probe.png.
- GET /workspaces/{workspaceId}/session/{sessionId}/message returned 200 and the same attachment on the stored tool part.
- Deleted only the probe scratch file created for this test. GET /workspaces/{workspaceId}/file/raw?path={retainedPath} then returned 200, Content-Type image/png, 70 bytes, byte-for-byte equal to the original fixture.
- Reopened the session in the running desktop. Accessibility state showed a View image tool row and a separate thumbnail button named claxedo-image-retention-probe.png.
- Clicking that button opened the image dialog (Close button and image with the matching filename). Escape returned to the transcript. Native accessibility observations lagged some actions; a fresh full tree confirmed the final state. Screenshot output appeared stale, so it is not claimed as visual pixel-quality evidence. The probe is a one-pixel fixture.

The previously failing native image rows inspected in this workspace were recorded before the daemon restart. They contain the real imageView event but tool name tool and no attachments. This does not prove every reported failure was an old row, but it distinguishes those historical failures from the passing fresh call.

## Commands run in this continuation

From packages/agent-sdk-runtime:

`bun test src/harnesses/codex/image-view.test.ts src/harnesses/codex/workspace-behavior.test.ts -t 'retains|rejects missing|reports oversized'`

Result: 4 passed, 0 failed, 24 filtered out. Covers retained bytes after deletion, completion projection, missing/non-image paths, oversized images, and actual driver integration using a scripted harness.

From packages/claxedo-app:

`bun run test:vitest src/features/session/ui/tool-attachments.vitest.tsx`

Result: 6 passed. Includes click, Enter, Escape, workspace URL resolution and multiple images. The run emitted a test-environment SVG sprite URL warning.

At repository root:

`git diff --check`

Result: failed due to an existing/concurrent blank line at EOF in packages/agent-sdk-runtime/src/runtime/turn-admission.ts:164. That file was not edited in this continuation.

No architecture ratchet run was required: this continuation changed no production imports.

## Remaining cross-harness work

The native Codex path is verified by the live evidence above. This is not an all-harness completion report.

- Codex MCP and Pi extract content-block images through agent-event-runtime/src/harnesses/tool-attachments.ts. They still apply its inline size policy.
- Claude uses imageAttachment, which can reference the original workspace file without retaining a copy. Such references are not durable against source deletion or modification.
- Cursor's tool completion and ACP's tool-output construction need explicit attachment extraction and representative fixtures.
- Shared filesystem retention still lives on the Codex native path, using the shared prompt materializer. A cross-harness change must preserve genuine result bytes before the current helper discards them, await retention before completion publication, and preserve event ordering and child-session ownership.
- Full live-provider acceptance for Claude, Pi, Cursor, ACP and MCP-backed image tools remains unverified. Historical rows have not been repaired.
