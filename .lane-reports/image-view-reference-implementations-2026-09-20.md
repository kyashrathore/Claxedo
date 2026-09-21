# Image-view reference implementations

Read-only investigation of installed products and official sources, 2026-09-20. No production code changed.

## Codex desktop

Inspected /Applications/ChatGPT.app/Contents/Resources/app.asar using the repository-installed @electron/asar reader.

- webview/assets/app-initial-a498f911edeb.js: the imageView case creates an image-view presentation item with imagePaths: [n.path]. Adjacent image views append their original paths.
- webview/assets/conversation-blocks-6c1d988a9fe3.js: Qb renders those paths through Bb, then zb, with useImageDialog enabled. zb resolves an absolute path with the imported Li function and uses the returned source for the thumbnail and dialog.
- Li is exported as S1t from app-initial and resolves to pw. pw calls tUn and constructs a data URL from returned bytes.
- tUn calls read-file-binary with path and hostId through a query cache (five-minute gcTime, infinite staleTime, retry false). It returns contentsBase64 and MIME; errors return null and log Failed to inline local image.
- This inspected native image-view preview path reads the original file on demand. It does not require a workspace attachment copy. Cache behavior is not a guarantee that the preview survives deletion and a fresh process.

The open-source model-facing handler independently reads and validates file bytes, constructs a data URL, emits ImageView with its path, and returns inline image content to the model:
https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/view_image.rs

## Claude Code

Inspected image tool_result block shapes in the local Claude Code transcript directory. Observed image blocks whose source has type base64, media_type image/jpeg and data; sample encoded lengths were 2068 and 8320. Image payloads were not printed or exported.

This verifies that image bytes already exist in the saved tool result for these examples. Rendering these results does not require creating another workspace file. It does not establish every Claude UI cache or storage policy.

## Cursor

Inspected /Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.glass.main.js.

- agent.v1.ReadSuccess defines path, an output union of content or binary data, and optional output_blob_id.
- The local read executor delegates to remoteReadExecutor when necessary. On a successful binary result it computes Gfe(bytes), calls blobStore.setBlob(context, id, bytes), and returns outputBlobId on ReadSuccess.
- Its blobStore is rD. ComposerBlobStore.setBlob calls enqueueBlobWrite; the corresponding reader uses storageService.cursorDiskKVGet. This is app blob storage, not a requirement to put a copy in the project.
- This confirms a byte/blob result path. The complete image preview rendering path was not traced, so no claim is made that every Cursor image is path-only or never retained.

Official documentation confirms Read files supports images and adds them to conversation context:
https://cursor.com/docs/agent/overview

## Implication for Claxedo

Copying into .claxedo/attachments is not inherently required for clickable image previews. It implements a stronger snapshot guarantee than the user's original preview requirement.

A simpler proposed design is to preserve inline bytes when the harness provides them, and preserve a host-scoped file reference when it provides a path. The existing shared viewer consumes the resolved image. File references require authorized reads on the owning runtime, including explicit handling for tool-viewed files outside the workspace; do not simply remove the workspace file-serving restriction. Missing originals can show an unavailable state. Durable archival is a separate product decision, not a prerequisite for rendering a viewed image.
