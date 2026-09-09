# Icon mapping review · September 9, 2026

128 app icon names. The latest user decisions are applied; glasses is the only remaining artwork correction. The story renders both theme columns through the same production component, including explicit shared-artwork choices.

## Current decisions

- `three-dots` is the single overflow icon API. `kebab`, `more-horizontal` and the app-only `outline-dots` alias are removed. The browser rotates it 90 degrees; sidebar overflow stays horizontal.
- `folders` is the single folder-stack identity. `file-tree` and `file-tree-active` app names are removed. OpenCode `folder-open` also uses `folders`; Codex retains its open-folder drawing.
- Both themes use Codex artwork for globe, cloud, gauge, reload, reset and worktree. Both use OpenCode’s Discord brand mark and >_ artwork for process and terminal states. [Authoritative artwork policy](/Users/yashvardhansingh/test/opencode/packages/ui/src/components/icon-artwork-policy.tsx).
- Accepted as-is for now, with comments in the mapping source: layout-right-full, layout-right-partial, monitor, new-session-active, review-active, server, arrow-down-to-line, chevron-double-left, chevron-double-right, circle-ban-sign and code-lines.
- Both themes use the bare OpenCode >_ prompt; active state only changes foreground emphasis. Raw-message and edit/write/patch file accordions use down/up carets from the trigger’s expanded state.
- Raw upstream inventories retain their upstream names; the app vocabulary is separate from the extracted source inventory.

## Remaining correction

`glasses`: Codex artwork still needs review. It appears in file-read tool headers and the shared BasicTool read-intent icon. [Open usage table](http://localhost:6006/iframe.html?id=reference-codex-icon-system--complete-reference&viewMode=story#usage).

- [packages/session-ui/src/components/basic-tool.tsx:408](/Users/yashvardhansingh/test/opencode/packages/session-ui/src/components/basic-tool.tsx:408)
- [packages/session-ui/src/components/basic-tool.tsx:425](/Users/yashvardhansingh/test/opencode/packages/session-ui/src/components/basic-tool.tsx:425)
- [packages/session-ui/src/components/message-part.tsx:519](/Users/yashvardhansingh/test/opencode/packages/session-ui/src/components/message-part.tsx:519)
- [packages/session-ui/src/components/message-part.tsx:2213](/Users/yashvardhansingh/test/opencode/packages/session-ui/src/components/message-part.tsx:2213)

## Effective mappings

| App name | Codex theme | Other themes | Review |
|---|---|---|---|
| `align-right` | `codex: codex-native-arrow-forward-line-vertical-light-16` | `opencode: align-right` | Accepted / not flagged |
| `arrow-down-to-line` | `codex: codex-20-012` | `opencode: arrow-down-to-line` | Accepted / not flagged |
| `arrow-left` | `codex: codex-20-033` | `opencode: arrow-left` | Accepted / not flagged |
| `arrow-right` | `codex: codex-native-arrow-left-lg-light-20` | `opencode: arrow-right` | Accepted / not flagged |
| `arrow-undo-down` | `codex: codex-20-059` | `opencode: arrow-undo-down` | Accepted / not flagged |
| `arrow-up` | `codex: codex-20-002` | `opencode: arrow-up` | Accepted / not flagged |
| `archive` | `codex: codex-20-144` | `opencode: archive` | Accepted / not flagged |
| `brain` | `codex: codex-20-113` | `opencode: brain` | Accepted / not flagged |
| `branch` | `codex: codex-20-037` | `opencode: branch` | Accepted / not flagged |
| `bubble-5` | `codex: codex-20-153` | `opencode: bubble-5` | Accepted / not flagged |
| `check` | `codex: codex-custom-check` | `opencode: check` | Accepted / not flagged |
| `check-small` | `codex: codex-custom-check` | `opencode: check-small` | Accepted / not flagged |
| `checklist` | `codex: codex-20-139` | `opencode: checklist` | Accepted / not flagged |
| `chevron-double-left` | `codex: codex-20-001` | `opencode: chevron-double-left` | Accepted / not flagged |
| `chevron-double-right` | `codex: codex-20-001` | `opencode: chevron-double-right` | Accepted / not flagged |
| `chevron-down` | `codex: codex-20-001` | `opencode: chevron-down` | Accepted / not flagged |
| `chevron-left` | `codex: codex-20-001` | `opencode: chevron-left` | Accepted / not flagged |
| `chevron-right` | `codex: codex-20-001` | `opencode: chevron-right` | Accepted / not flagged |
| `circle-alert` | `codex: codex-20-008` | `opencode: circle-alert` | Accepted / not flagged |
| `circle-ban-sign` | `codex: codex-20-121` | `opencode: circle-ban-sign` | Accepted / not flagged |
| `circle-check` | `codex: codex-native-checkmark-circle-light-16` | `opencode: circle-check` | Accepted / not flagged |
| `circle-dashed` | `codex: codex-native-circle-dashed` | `opencode: circle-dashed` | Accepted / not flagged |
| `circle-half` | `codex: codex-20-145` | `opencode: circle-half` | Accepted / not flagged |
| `circle-x` | `codex: codex-20-121` | `opencode: circle-x` | Accepted / not flagged |
| `claude` | `codex: codex-custom-claude` | `opencode: claude` | Accepted / not flagged |
| `close` | `codex: codex-custom-close` | `opencode: close` | Accepted / not flagged |
| `close-small` | `codex: codex-custom-close-small` | `opencode: close-small` | Accepted / not flagged |
| `cloud` | `codex: codex-native-cloud-light-16` | `codex: codex-native-cloud-light-16` | Accepted / not flagged |
| `cloud-upload` | `codex: codex-native-cloud-upload` | `opencode: cloud-upload` | Accepted / not flagged |
| `code` | `codex: codex-20-022` | `opencode: code` | Accepted / not flagged |
| `code-lines` | `codex: codex-20-128` | `opencode: code-lines` | Accepted / not flagged |
| `collapse` | `codex: codex-custom-panel-restore` | `opencode: collapse` | Accepted / not flagged |
| `collapse-all` | `codex: codex-custom-collapse-all` | `opencode: collapse-all` | Accepted / not flagged |
| `comment` | `codex: codex-20-153` | `opencode: comment` | Accepted / not flagged |
| `copy` | `codex: codex-custom-copy` | `opencode: copy` | Accepted / not flagged |
| `cursor` | `codex: codex-custom-cursor` | `opencode: cursor` | Accepted / not flagged |
| `changes` | `codex: codex-20-071` | `opencode: review` | Accepted / not flagged |
| `dash` | `codex: codex-20-053` | `opencode: dash` | Accepted / not flagged |
| `discord` | `opencode: discord` | `opencode: discord` | Accepted / not flagged |
| `download` | `codex: codex-20-012` | `opencode: download` | Accepted / not flagged |
| `edit` | `codex: codex-20-019` | `opencode: edit-small-2` | Accepted / not flagged |
| `edit-small-2` | `codex: codex-20-019` | `opencode: edit-small-2` | Accepted / not flagged |
| `enter` | `codex: codex-native-arrow-curved-right-large-typographic-light-20` | `opencode: enter` | Accepted / not flagged |
| `expand` | `codex: codex-native-arrow-up-right-arrow-down-left-sm-light-20` | `opencode: expand` | Accepted / not flagged |
| `expand-all` | `codex: codex-custom-expand-all` | `opencode: expand-all` | Accepted / not flagged |
| `eye` | `codex: codex-native-eye-light-20` | `opencode: eye` | Accepted / not flagged |
| `file` | `codex: codex-custom-file` | `opencode: file` | Accepted / not flagged |
| `document-text` | `codex: codex-native-text-document-light-20` | `opencode: document-text` | Accepted / not flagged |
| `folder` | `codex: codex-custom-folder` | `opencode: folder` | Accepted / not flagged |
| `folder-add` | `codex: codex-20-031` | `opencode: folder-add` | Accepted / not flagged |
| `folder-open` | `codex: codex-custom-folder-open` | `opencode: folders` | Accepted / not flagged |
| `folders` | `codex: codex-native-folder-on-folder-light-16` | `opencode: folders` | Accepted / not flagged |
| `fork` | `codex: codex-20-093` | `opencode: fork` | Accepted / not flagged |
| `gauge` | `codex: codex-20-107` | `codex: codex-20-107` | Accepted / not flagged |
| `github` | `codex: codex-20-043` | `opencode: github` | Accepted / not flagged |
| `glasses` | `codex: codex-20-048` | `opencode: glasses` | Needs correction |
| `globe` | `codex: codex-20-011` | `codex: codex-20-011` | Accepted / not flagged |
| `help` | `codex: codex-20-007` | `opencode: help` | Accepted / not flagged |
| `keyboard` | `codex: codex-native-keyboard-light-20` | `opencode: keyboard` | Accepted / not flagged |
| `inspect-element` | `codex: codex-20-109` | `opencode: window-cursor` | Accepted / not flagged |
| `layout-bottom` | `codex: codex-native-dock-light-16` | `opencode: layout-bottom` | Accepted / not flagged |
| `layout-left` | `codex: codex-20-034` | `opencode: layout-left` | Accepted / not flagged |
| `layout-left-full` | `codex: codex-20-035` | `opencode: layout-left-full` | Accepted / not flagged |
| `layout-left-partial` | `codex: codex-20-034` | `opencode: layout-left-partial` | Accepted / not flagged |
| `layout-right-full` | `codex: codex-20-035` | `opencode: layout-right-full` | Accepted / not flagged |
| `layout-right-partial` | `codex: codex-20-034` | `opencode: layout-right-partial` | Accepted / not flagged |
| `link` | `codex: codex-native-link-light-16` | `opencode: link` | Accepted / not flagged |
| `magnifying` | `codex: codex-custom-magnifying-glass` | `opencode: magnifying-glass` | Accepted / not flagged |
| `magnifying-glass` | `codex: codex-custom-magnifying-glass` | `opencode: magnifying-glass` | Accepted / not flagged |
| `magnifying-glass-menu` | `codex: codex-custom-magnifying-glass-menu` | `opencode: magnifying-glass-menu` | Accepted / not flagged |
| `marketplace` | `codex: codex-custom-marketplace` | `opencode: marketplace` | Accepted / not flagged |
| `maximize` | `codex: codex-native-arrow-up-right-arrow-down-left-sm-light-20` | `opencode: maximize` | Accepted / not flagged |
| `mcp` | `codex: codex-custom-mcp` | `opencode: mcp` | Accepted / not flagged |
| `models` | `codex: codex-custom-models` | `opencode: models` | Accepted / not flagged |
| `monitor` | `codex: codex-20-101` | `opencode: monitor` | Accepted / not flagged |
| `three-dots` | `codex: codex-custom-three-dots` | `opencode: three-dots` | Accepted / not flagged |
| `new-session` | `codex: codex-20-019` | `opencode: new-session` | Accepted / not flagged |
| `new-session-active` | `codex: codex-20-019` | `opencode: new-session-active` | Accepted / not flagged |
| `openai` | `codex: codex-custom-openai` | `opencode: openai` | Accepted / not flagged |
| `opencode` | `codex: codex-custom-opencode` | `opencode: opencode` | Accepted / not flagged |
| `open-file` | `codex: codex-native-open-link-light-16` | `opencode: open-file` | Accepted / not flagged |
| `outline-chevron-down` | `codex: codex-20-001` | `opencode: chevron-down` | Accepted / not flagged |
| `outline-copy` | `codex: codex-custom-copy` | `opencode: copy` | Accepted / not flagged |
| `outline-share` | `codex: codex-20-083` | `opencode: share` | Accepted / not flagged |
| `outline-sliders` | `codex: codex-20-079` | `opencode: sliders` | Accepted / not flagged |
| `outline-xmark` | `codex: codex-custom-close` | `opencode: close-small` | Accepted / not flagged |
| `page` | `codex: codex-native-document-light-20` | `opencode: file` | Accepted / not flagged |
| `page-plus` | `codex: codex-custom-page-plus` | `opencode: page-plus` | Accepted / not flagged |
| `pencil` | `codex: codex-20-019` | `opencode: pencil-line` | Accepted / not flagged |
| `pencil-line` | `codex: codex-20-019` | `opencode: pencil-line` | Accepted / not flagged |
| `photo` | `codex: codex-native-photo-light-20` | `opencode: photo` | Accepted / not flagged |
| `pi` | `codex: codex-custom-pi` | `opencode: pi` | Accepted / not flagged |
| `plus` | `codex: codex-20-006` | `opencode: plus` | Accepted / not flagged |
| `plus-small` | `codex: codex-20-006` | `opencode: plus-small` | Accepted / not flagged |
| `process` | `opencode: terminal` | `opencode: terminal` | Accepted / not flagged |
| `process-cwd` | `codex: codex-20-152` | `opencode: folder` | Accepted / not flagged |
| `prompt` | `codex: codex-20-153` | `opencode: prompt` | Accepted / not flagged |
| `providers` | `codex: codex-custom-providers` | `opencode: providers` | Accepted / not flagged |
| `reload` | `codex: codex-20-004` | `codex: codex-20-004` | Accepted / not flagged |
| `reset` | `codex: codex-20-078` | `codex: codex-20-078` | Accepted / not flagged |
| `review` | `codex: codex-20-071` | `opencode: review` | Accepted / not flagged |
| `review-active` | `codex: codex-20-071` | `opencode: review-active` | Accepted / not flagged |
| `scroll-to-latest` | `codex: codex-20-002` | `opencode: arrow-down-to-line` | Accepted / not flagged |
| `server` | `codex: codex-20-127` | `opencode: server` | Accepted / not flagged |
| `send` | `codex: codex-custom-send` | `opencode: arrow-up` | Accepted / not flagged |
| `settings` | `codex: codex-20-051` | `opencode: settings-gear` | Accepted / not flagged |
| `settings-gear` | `codex: codex-20-051` | `opencode: settings-gear` | Accepted / not flagged |
| `share` | `codex: codex-20-083` | `opencode: share` | Accepted / not flagged |
| `shield` | `codex: codex-20-116` | `opencode: shield` | Accepted / not flagged |
| `sidebar` | `codex: codex-20-034` | `opencode: sidebar` | Accepted / not flagged |
| `sidebar-active` | `codex: codex-20-035` | `opencode: sidebar-active` | Accepted / not flagged |
| `sliders` | `codex: codex-20-079` | `opencode: sliders` | Accepted / not flagged |
| `speech` | `codex: codex-20-153` | `opencode: speech-bubble` | Accepted / not flagged |
| `speech-bubble` | `codex: codex-20-153` | `opencode: speech-bubble` | Accepted / not flagged |
| `split` | `codex: codex-custom-diff-split` | `opencode: split` | Accepted / not flagged |
| `open-external` | `codex: codex-20-055` | `opencode: open-external` | Accepted / not flagged |
| `stop` | `codex: codex-custom-stop` | `opencode: stop` | Accepted / not flagged |
| `subagent` | `codex: codex-20-110` | `opencode: subagent` | Accepted / not flagged |
| `task` | `codex: codex-20-139` | `opencode: checklist` | Accepted / not flagged |
| `terminal` | `opencode: terminal` | `opencode: terminal` | Accepted / not flagged |
| `terminal-active` | `opencode: terminal-active` | `opencode: terminal-active` | Accepted / not flagged |
| `trash` | `codex: codex-20-080` | `opencode: trash` | Accepted / not flagged |
| `unified` | `codex: codex-custom-diff-unified` | `opencode: unified` | Accepted / not flagged |
| `warning` | `codex: codex-20-082` | `opencode: warning` | Accepted / not flagged |
| `window-cursor` | `codex: codex-native-web-browser-cursor-light-16` | `opencode: window-cursor` | Accepted / not flagged |
| `workspace-new` | `codex: codex-native-folder-add` | `opencode: folder-add` | Accepted / not flagged |
| `worktree` | `codex: codex-custom-worktree` | `codex: codex-custom-worktree` | Accepted / not flagged |
| `xmark-small` | `codex: codex-custom-close-small` | `opencode: close-small` | Accepted / not flagged |

## Validation

- packages/claxedo-app: `bun test src/ui/icons/registry.test.ts` — 15 passed.
- packages/claxedo-app: `bun run test:vitest -- src/ui/controls/claxedo-icon.vitest.tsx src/ui/controls/claxedo-icon-theme.vitest.tsx src/ui/icon-sprite-reactivity.vitest.tsx src/ui/semantic-icon.vitest.tsx` — 19 passed, including cross-theme shared-artwork geometry and state transitions.
- packages/ui: `bun test src/components/codex-icon-map.test.ts src/storybook/icon-mapping-audit.test.ts src/storybook/opencode-icon-extraction.test.ts` — 11 passed.
- `bun run typecheck` in packages/claxedo-app, packages/ui and packages/session-ui — passed.
- Root: `bun run test:architecture-ratchets` — passed; no ceiling changes.
- packages/ui: `bun run extract:icons` — 119 v1 / 37 v2 renderer entries after retiring the corner-only panel-expand helper.
- packages/storybook: `bun run build` — passed.
- Live Storybook: visually checked shared cloud, Discord, globe, gauge, reload, reset and worktree pairs; consolidated folders and OpenCode folder-open; and horizontal/vertical three-dot examples in both themes. Mapping filters show 128 pairs, one correction (`glasses`), and 127 not flagged.

### Workspace panel arrow pair

`WorkspacePanelChrome` selects `expand` at normal width and `collapse` at full width. Codex expand now resolves to the existing native outward-arrow artwork; restore retains its native inward arrows. OpenCode expand and collapse both include diagonal arrow shafts. The workspace panel lifecycle story previews and toggles this pair in both themes.

- packages/claxedo-app: `bun run test:vitest -- src/ui/controls/claxedo-icon.vitest.tsx src/ui/controls/claxedo-icon-theme.vitest.tsx src/app/workbench/rail/workbench-shell-header.vitest.tsx` — 20 passed. The header suite logs a relative sprite-URL fetch warning in jsdom; the icon suites load the real sprite and live Storybook confirms it renders.
- packages/claxedo-app: `bun run typecheck` — passed after the arrow changes.
- packages/ui: `bun test src/components/codex-icon-map.test.ts src/storybook/icon-mapping-audit.test.ts src/storybook/opencode-icon-extraction.test.ts` — 11 passed after regenerating the inventory.
- Live Storybook: visually checked outward and inward arrows in both themes and exercised the expand/restore buttons.

### Shared process and terminal artwork

`ICON_ARTWORK_POLICY` selects OpenCode for `process`, `terminal`, and `terminal-active` in every theme. Process resolves to the same >_ geometry as terminal; active terminals keep the same bare prompt and brighten it. The original OpenCode console artwork is retained under the canonical terminal name, with no square frame.

- packages/claxedo-app: `bun run test:vitest -- src/ui/controls/claxedo-icon-theme.vitest.tsx src/ui/controls/claxedo-icon.vitest.tsx src/ui/semantic-icon.vitest.tsx` — 18 passed, including shared/app geometry equality across themes and terminal state transitions.
- `bun run typecheck` in packages/claxedo-app and packages/ui — passed.
- Live Storybook: visually verified matching Processes/Create terminal artwork and both terminal states in the Codex and OpenCode columns.
