import { PROCESS_ICON_GLYPHS } from "./process-icon-map"

/**
 * ⚠️ Licence risk — see the note in `./codex-icons.tsx`. These ids address
 * artwork extracted byte-identically from the proprietary ChatGPT desktop app,
 * not from the Apache-2.0 `openai/codex` repository. Known, accepted for now.
 */
export const UI_CODEX_ICON_ALIASES = {
  "pi": "codex-custom-pi",
  "opencode": "codex-custom-opencode",
  "openai": "codex-custom-openai",
  "cursor": "codex-custom-cursor",
  "claude": "codex-custom-claude",
  "collapse-all": "codex-custom-collapse-all",
  "expand-all": "codex-custom-expand-all",
  "unified": "codex-custom-diff-unified",
  "split": "codex-custom-diff-split",
  "monitor": "codex-20-101",
  "document-text": "codex-native-text-document-light-20",

  "circle": "codex-native-circle-light-16",

  ...PROCESS_ICON_GLYPHS.codex,
  "align-right": "codex-native-arrow-forward-line-vertical-light-16",
  "arrow-down-to-line": "codex-20-012",
  "arrow-left": "codex-20-033",
  "arrow-right": "codex-native-arrow-left-lg-light-20",
  "arrow-undo-down": "codex-20-059",
  "arrow-up": "codex-20-002",
  archive: "codex-20-144",
  brain: "codex-20-113",
  branch: "codex-20-037",
  "bubble-5": "codex-20-153",
  "bullet-list": "codex-20-097",
  check: "codex-custom-check",
  "check-small": "codex-custom-check",
  checklist: "codex-20-139",
  "chevron-double-left": "codex-20-001",
  "chevron-double-right": "codex-20-001",
  "chevron-down": "codex-20-001",
  "chevron-grabber-vertical": "codex-20-053",
  "chevron-left": "codex-20-001",
  "chevron-right": "codex-20-001",
  "circle-alert": "codex-20-008",
  "circle-ban-sign": "codex-20-121",
  "circle-check": "codex-native-checkmark-circle-light-16",
  "circle-dashed": "codex-native-circle-dashed",
  "circle-half": "codex-20-145",
  "circle-x": "codex-20-121",
  /* `close` is a dismiss affordance, not a status mark, so it draws the bare X
     from the local table. The bulk-generated alias table pointed it at
     `codex-20-121` — the *circled* X that `circle-x` and `circle-ban-sign`
     legitimately use — which put a ringed glyph on every toast, dialog and
     popover close button. The extracted sprite has no plain X of its own. */
  close: "codex-custom-close",
  "close-small": "codex-custom-close-small",
  "cloud-upload": "codex-native-cloud-upload",
  code: "codex-20-022",
  "code-lines": "codex-20-128",
  collapse: "codex-custom-panel-restore",
  comment: "codex-20-153",
  copy: "codex-custom-copy",
  "outline-copy": "codex-custom-copy",
  dash: "codex-20-053",
  discord: "codex-20-153",
  download: "codex-20-012",
  "three-dots": "codex-custom-three-dots",
  edit: "codex-20-019",
  "edit-small-2": "codex-20-019",
  "enter": "codex-native-arrow-curved-right-large-typographic-light-20",
  expand: "codex-native-arrow-up-right-arrow-down-left-sm-light-20",
  "eye": "codex-native-eye-light-20",
  file: "codex-custom-file",
  folders: "codex-native-folder-on-folder-light-16",
  folder: "codex-custom-folder",
  "folder-add": "codex-20-031",
  fork: "codex-20-093",
  github: "codex-20-043",
  glasses: "codex-20-048",
  help: "codex-20-007",
  "keyboard": "codex-native-keyboard-light-20",
  "layout-bottom": "codex-native-dock-light-16",
  "layout-bottom-full": "codex-20-126",
  "layout-bottom-partial": "codex-20-138",
  "layout-left": "codex-20-034",
  "layout-left-full": "codex-20-035",
  "layout-left-partial": "codex-20-034",
  "layout-right": "codex-20-034",
  "layout-right-full": "codex-20-035",
  "layout-right-partial": "codex-20-034",
  "link": "codex-native-link-light-16",
  "magnifying-glass": "codex-custom-magnifying-glass",
  "magnifying-glass-menu": "codex-custom-magnifying-glass-menu",
  // `marketplace`, `models` and `providers` all aliased codex-20-123 — one
  // sparkle standing in for three unrelated destinations, so the Settings nav
  // showed an identical mark for Providers and for Models. The extracted sprite
  // carries no distinct glyph for any of them, so each is drawn locally; see
  // `CODEX_CUSTOM_GLYPHS` in ./icon.tsx.
  marketplace: "codex-custom-marketplace",
  "maximize": "codex-native-arrow-up-right-arrow-down-left-sm-light-20",
  // The extracted sprite carries no MCP mark, so this pointed at codex-20-129 —
  // the same node-graph glyph as `link`, which is why MCP tool rows read as
  // graph nodes. Drawn locally instead, same as `marketplace` and `models`
  // above; see `CODEX_CUSTOM_GLYPHS` in ./icon.tsx.
  mcp: "codex-custom-mcp",
  menu: "codex-20-097",
  models: "codex-custom-models",
  "new-session": "codex-20-019",
  "new-session-active": "codex-20-019",
  "open-file": "codex-native-open-link-light-16",
  "page-plus": "codex-custom-page-plus",
  pencil: "codex-20-019",
  "pencil-line": "codex-20-019",
  "photo": "codex-native-photo-light-20",
  plus: "codex-20-006",
  "plus-small": "codex-20-006",
  prompt: "codex-20-153",
  providers: "codex-custom-providers",
  reset: "codex-20-078",
  review: "codex-20-071",
  "review-active": "codex-20-071",
  server: "codex-20-127",
  "settings-gear": "codex-20-051",
  // 082 is the warning triangle and 083 the share arrow — verified by rendering
  // both symbols from the sprite. The map had each name pointing one symbol early,
  // so `warning` resolved to 081 (two diagonal strokes hardcoded to an undefined
  // `var(--gray-300)`, i.e. invisible) and `share` drew the triangle.
  share: "codex-20-083",
  shield: "codex-20-116",
  sidebar: "codex-20-034",
  "sidebar-active": "codex-20-035",
  sliders: "codex-20-079",
  "speech-bubble": "codex-20-153",
  "open-external": "codex-20-055",
  status: "codex-20-122",
  "status-active": "codex-20-122",
  stop: "codex-custom-stop",
  task: "codex-20-139",
  terminal: "codex-20-050",
  // Raw Codex source mapping. The shared artwork policy selects OpenCode
  // for both terminal states in every theme.
  "terminal-active": "codex-20-050",
  trash: "codex-20-080",
  warning: "codex-20-082",
  "window-cursor": "codex-native-web-browser-cursor-light-16",
  wrench: "codex-20-014",
} as const

export const UI_CODEX_ICON_TRANSFORMS = {
  "enter": "translate(20 0) scale(-1 1)",
  "arrow-right": "translate(20 0) scale(-1 1)",
  "chevron-double-left": "rotate(180 10 10)",
  "chevron-down": "rotate(90 10 10)",
  "chevron-grabber-vertical": "rotate(90 10 10)",
  "chevron-left": "rotate(180 10 10)",
  copy: "translate(-2 -2) scale(1.2)",
  "layout-right": "rotate(180 10 10)",
  "layout-right-full": "rotate(180 10 10)",
  "layout-right-partial": "rotate(180 10 10)",
  "outline-copy": "translate(-2 -2) scale(1.2)",
} as const satisfies Partial<Record<keyof typeof UI_CODEX_ICON_ALIASES, string>>
