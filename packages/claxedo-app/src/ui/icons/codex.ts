// ⚠️ Licence risk — see the note in
// `packages/ui/src/components/codex-icons.tsx`. Every `codex-20-*` id below
// addresses artwork extracted byte-identically from the proprietary ChatGPT
// desktop app; it is NOT from the Apache-2.0 `openai/codex` repository. Known
// and accepted for now. Switching `ACTIVE_ICON_LIBRARY` in ./config.ts to
// "opencode" reverts the app to the unencumbered upstream set.
import { APP_ICONS, type AppIconName } from "@/ui/icons/catalog"
import { defineIconLibrary } from "@/ui/icons/registry"

type CodexSpriteGlyph = `codex-20-${string}`
type CodexCustomGlyph =
  | "codex-custom-claude"
  | "codex-custom-close-small"
  | "codex-custom-copy"
  | "codex-custom-cursor"
  | "codex-custom-folder"
  | "codex-custom-folder-open"
  | "codex-custom-collapse-all"
  | "codex-custom-diff-split"
  | "codex-custom-diff-unified"
  | "codex-custom-expand-all"
  | "codex-custom-kebab"
  | "codex-custom-magnifying-glass"
  | "codex-custom-magnifying-glass-menu"
  | "codex-custom-more-horizontal"
  | "codex-custom-openai"
  | "codex-custom-opencode"
  | "codex-custom-panel-expand"
  | "codex-custom-panel-restore"
  | "codex-custom-pin"
  | "codex-custom-pin-filled"
  | "codex-custom-pi"
  | "codex-custom-send"
  | "codex-custom-stop"
  | "codex-custom-worktree"

export type CodexGlyphName = CodexSpriteGlyph | CodexCustomGlyph

export const CODEX_ICON_ALIASES = {
  "align-right": "codex-20-058",
  "arrow-down-to-line": "codex-20-012",
  "arrow-left": "codex-20-033",
  "arrow-right": "codex-20-058",
  "arrow-undo-down": "codex-20-059",
  "arrow-up": "codex-20-002",
  archive: "codex-20-144",
  brain: "codex-20-113",
  branch: "codex-20-037",
  "bubble-5": "codex-20-153",
  "bullet-list": "codex-20-097",
  check: "codex-20-139",
  "check-small": "codex-20-139",
  checklist: "codex-20-139",
  "chevron-double-left": "codex-20-001",
  "chevron-double-right": "codex-20-001",
  "chevron-down": "codex-20-001",
  "chevron-grabber-vertical": "codex-20-053",
  "chevron-left": "codex-20-001",
  "chevron-right": "codex-20-001",
  circle: "codex-20-122",
  "circle-alert": "codex-20-008",
  "circle-ban-sign": "codex-20-121",
  "circle-check": "codex-20-139",
  "circle-dashed": "codex-20-122",
  "circle-half": "codex-20-145",
  "circle-x": "codex-20-121",
  claude: "codex-custom-claude",
  close: "codex-20-121",
  "close-small": "codex-custom-close-small",
  cloud: "codex-20-087",
  "cloud-upload": "codex-20-087",
  code: "codex-20-022",
  "code-lines": "codex-20-128",
  collapse: "codex-custom-panel-restore",
  "collapse-all": "codex-custom-collapse-all",
  comment: "codex-20-153",
  console: "codex-20-050",
  copy: "codex-custom-copy",
  cursor: "codex-custom-cursor",
  changes: "codex-20-120",
  dash: "codex-20-053",
  discord: "codex-20-153",
  download: "codex-20-012",
  "dot-grid": "codex-custom-more-horizontal",
  edit: "codex-20-019",
  "edit-small-2": "codex-20-019",
  enter: "codex-20-002",
  expand: "codex-custom-panel-expand",
  "expand-all": "codex-custom-expand-all",
  eye: "codex-20-106",
  file: "codex-20-098",
  "file-text": "codex-20-098",
  "file-tree": "codex-20-138",
  "file-tree-active": "codex-20-138",
  filetree: "codex-20-138",
  folder: "codex-custom-folder",
  "folder-add-left": "codex-20-031",
  "folder-open": "codex-custom-folder-open",
  folders: "codex-20-057",
  fork: "codex-20-093",
  gauge: "codex-20-107",
  github: "codex-20-043",
  glasses: "codex-20-106",
  globe: "codex-20-011",
  "grid-plus": "codex-20-031",
  hand: "codex-20-115",
  help: "codex-20-007",
  kebab: "codex-custom-kebab",
  keyboard: "codex-20-025",
  laptop: "codex-20-101",
  "layout-bottom": "codex-20-138",
  "layout-bottom-full": "codex-20-126",
  "layout-bottom-partial": "codex-20-138",
  "layout-left": "codex-20-034",
  "layout-left-full": "codex-20-035",
  "layout-left-partial": "codex-20-034",
  "layout-right": "codex-20-034",
  "layout-right-full": "codex-20-035",
  "layout-right-partial": "codex-20-034",
  link: "codex-20-129",
  magnifying: "codex-custom-magnifying-glass",
  "magnifying-glass": "codex-custom-magnifying-glass",
  "magnifying-glass-menu": "codex-custom-magnifying-glass-menu",
  marketplace: "codex-20-123",
  maximize: "codex-custom-panel-expand",
  mcp: "codex-20-129",
  menu: "codex-20-097",
  models: "codex-20-123",
  monitor: "codex-20-101",
  "more-horizontal": "codex-custom-more-horizontal",
  "new-session": "codex-20-019",
  "new-session-active": "codex-20-019",
  openai: "codex-custom-openai",
  opencode: "codex-custom-opencode",
  "open-file": "codex-20-098",
  "outline-chevron-down": "codex-20-001",
  "outline-copy": "codex-custom-copy",
  "outline-dots": "codex-custom-more-horizontal",
  "outline-reset": "codex-20-078",
  "outline-share": "codex-20-082",
  "outline-sliders": "codex-20-079",
  "outline-square-arrow": "codex-20-055",
  "outline-xmark": "codex-20-121",
  page: "codex-20-098",
  "page-plus": "codex-20-031",
  pencil: "codex-20-019",
  "pencil-line": "codex-20-019",
  photo: "codex-20-047",
  pin: "codex-custom-pin",
  "pin-filled": "codex-custom-pin-filled",
  pi: "codex-custom-pi",
  play: "codex-20-068",
  plus: "codex-20-006",
  "plus-small": "codex-20-006",
  process: "codex-20-069",
  "process-command": "codex-20-050",
  "process-cwd": "codex-20-152",
  "process-name": "codex-20-069",
  prompt: "codex-20-153",
  providers: "codex-20-123",
  reload: "codex-20-004",
  reset: "codex-20-078",
  review: "codex-20-071",
  "review-active": "codex-20-071",
  "scroll-to-latest": "codex-20-002",
  server: "codex-20-127",
  send: "codex-custom-send",
  selector: "codex-20-001",
  settings: "codex-20-051",
  "settings-gear": "codex-20-051",
  share: "codex-20-082",
  shield: "codex-20-116",
  sidebar: "codex-20-034",
  "sidebar-active": "codex-20-035",
  "sidebar-right": "codex-20-034",
  sliders: "codex-20-079",
  speech: "codex-20-153",
  "speech-bubble": "codex-20-153",
  split: "codex-custom-diff-split",
  "square-arrow-top-right": "codex-20-055",
  status: "codex-20-122",
  "status-active": "codex-20-122",
  stop: "codex-custom-stop",
  subagent: "codex-20-110",
  task: "codex-20-139",
  terminal: "codex-20-050",
  "terminal-active": "codex-20-050",
  "terminal-square": "codex-20-050",
  trash: "codex-20-080",
  unified: "codex-custom-diff-unified",
  warning: "codex-20-081",
  "window-cursor": "codex-20-109",
  workgraph: "codex-20-129",
  workspace: "codex-20-032",
  "workspace-isolated": "codex-20-140",
  "workspace-new": "codex-20-032",
  worktree: "codex-custom-worktree",
  "xmark-small": "codex-20-121",
} as const satisfies Record<AppIconName, CodexGlyphName>

export const CODEX_ICON_TRANSFORMS = {
  "chevron-double-left": "rotate(180 10 10)",
  "chevron-down": "rotate(90 10 10)",
  "chevron-grabber-vertical": "rotate(90 10 10)",
  "chevron-left": "rotate(180 10 10)",
  "layout-right": "rotate(180 10 10)",
  "layout-right-full": "rotate(180 10 10)",
  "layout-right-partial": "rotate(180 10 10)",
  "outline-chevron-down": "rotate(90 10 10)",
  "scroll-to-latest": "rotate(180 10 10)",
  "sidebar-right": "rotate(180 10 10)",
  selector: "rotate(90 10 10)",
} as const satisfies Partial<Record<AppIconName, string>>

export const codexIconLibrary = defineIconLibrary<AppIconName, CodexGlyphName>({
  name: "codex",
  glyphs: [...new Set(Object.keys(APP_ICONS).map((name) => CODEX_ICON_ALIASES[name as AppIconName]))],
  aliases: CODEX_ICON_ALIASES,
})
