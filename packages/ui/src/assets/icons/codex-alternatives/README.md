# Applied native Codex artwork

These 21 SVGs come from the installed ChatGPT application, version 26.901.51231, build 8109. They supply approved production mappings and their Storybook source references. The production sprite combines the original build-5848 extraction with these separately prefixed native symbols.

The newer renderer contains a named icon system with 298 definitions, in addition to JSX icon components spread across renderer chunks. The keyboard, photo, eye, cloud, circle, lined document, browser cursor, link, and folder candidates were selected from that named system. Cloud upload, dashed circle, and folder add were extracted from static JSX components.

Each manifest entry records the renderer asset, full asset SHA-256, UTF-16 and byte offsets, original viewBox, SVG body, and body SHA-256. Named definitions retain their source name and optical metadata. JSX entries retain the minified component symbol and root attributes.

The SVG bodies and viewBoxes are preserved. The alias transform tables record the horizontal mirrors used for right-arrow and Enter. Native Codex replacements retain their original source artwork. The user-approved policy in `components/icon-artwork-policy.tsx` shares Codex globe, cloud, gauge, reload, reset and worktree artwork across themes, and OpenCode Discord artwork across themes. Other OpenCode-side replacements use native v1/v2 assets or approved custom artwork.

All selected shapes were visually inspected. Remaining cases are either explicitly accepted at their mapping source or marked unresolved. A mapping pair can have an applied replacement for one library and remain unresolved for the other.

From `packages/ui`, verify the captured artwork against the installed archive:

```sh
bun run script/sync-codex-alternatives.ts
bun run script/verify-codex-alternatives.ts
```

An alternate archive path can be passed as the first argument. The verification parses the source without executing it, compares native definitions and JSX geometry, checks both the reference and production sprites, and requires all applied Codex replacements to reference captured native artwork. It intentionally fails when the recorded renderer assets change: a newer app version needs a fresh extraction and visual review.

These assets have the same proprietary-app provenance as the original Codex extraction; they are not assets from the open-source Codex repository.
