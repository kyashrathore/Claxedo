import { PROCESS_ICON_GLYPHS } from "@opencode-ai/ui/process-icon-map"

import { appIconNames, type AppIconName } from "@/ui/icons/catalog"
import { defineIconLibrary } from "@/ui/icons/registry"

type CodexSpriteGlyph = `codex-20-${string}`
export type CodexCustomGlyph =
  | "codex-custom-activity"
  | "codex-custom-bell"
  | "codex-custom-check"
  | "codex-custom-claude"
  | "codex-custom-close"
  | "codex-custom-close-small"
  | "codex-custom-copy"
  | "codex-custom-cursor"
  | "codex-custom-file"
  | "codex-custom-folder"
  | "codex-custom-folder-open"
  | "codex-custom-collapse-all"
  | "codex-custom-diff-split"
  | "codex-custom-diff-unified"
  | "codex-custom-expand-all"
  | "codex-custom-magnifying-glass"
  | "codex-custom-magnifying-glass-menu"
  | "codex-custom-marketplace"
  | "codex-custom-mcp"
  | "codex-custom-bolt"
  | "codex-custom-models"
  | "codex-custom-three-dots"
  | "codex-custom-openai"
  | "codex-custom-opencode"
  | "codex-custom-panel-restore"
  | "codex-custom-page-plus"
  | "codex-custom-pi"
  | "codex-custom-providers"
  | "codex-custom-send"
  | "codex-custom-stop"
  | "codex-custom-worktree"

export type CodexGlyphName = CodexSpriteGlyph | CodexCustomGlyph | `codex-native-${string}`

export const CODEX_ICON_ALIASES = {
  activity: "codex-custom-activity",
  bell: "codex-custom-bell",
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
  check: "codex-custom-check",
  "check-small": "codex-custom-check",
  checklist: "codex-20-139",
  "chevron-double-left": "codex-20-001",
  "chevron-double-right": "codex-20-001",
  "chevron-down": "codex-20-001",
  "chevron-left": "codex-20-001",
  "chevron-right": "codex-20-001",
  "circle-alert": "codex-20-008",
  "circle-ban-sign": "codex-20-121",
  "circle-check": "codex-native-checkmark-circle-light-16",
  "circle-dashed": "codex-native-circle-dashed",
  "circle-half": "codex-20-145",
  "circle-x": "codex-20-121",
  claude: "codex-custom-claude",
  close: "codex-custom-close",
  "close-small": "codex-custom-close-small",
  "cloud": "codex-native-cloud-light-16",
  "cloud-upload": "codex-native-cloud-upload",
  code: "codex-20-022",
  "code-lines": "codex-20-128",
  collapse: "codex-custom-panel-restore",
  "collapse-all": "codex-custom-collapse-all",
  comment: "codex-20-153",
  copy: "codex-custom-copy",
  cursor: "codex-custom-cursor",
  changes: "codex-20-071",
  dash: "codex-20-053",
  discord: "codex-20-153",
  download: "codex-20-012",
  edit: "codex-native-square-and-pencil-light-20",
  "enter": "codex-native-arrow-curved-right-large-typographic-light-20",
  expand: "codex-native-arrow-up-right-arrow-down-left-sm-light-20",
  "expand-all": "codex-custom-expand-all",
  "eye": "codex-native-eye-light-20",
  file: "codex-custom-file",
  "document-text": "codex-native-text-document-light-20",
  folder: "codex-custom-folder",
  "folder-add": "codex-20-031",
  "folder-open": "codex-custom-folder-open",
  folders: "codex-native-folder-on-folder-light-16",
  fork: "codex-20-093",
  gauge: "codex-20-107",
  github: "codex-20-043",
  glasses: "codex-20-048",
  globe: "codex-20-011",
  help: "codex-20-007",
  "keyboard": "codex-native-keyboard-light-20",
  "inspect-element": "codex-20-109",
  "layout-bottom": "codex-native-dock-light-16",
  "layout-left": "codex-20-034",
  "layout-left-full": "codex-20-035",
  "layout-left-partial": "codex-20-034",
  "layout-right-full": "codex-20-035",
  "layout-right-partial": "codex-20-034",
  "link": "codex-native-link-light-16",
  magnifying: "codex-custom-magnifying-glass",
  "magnifying-glass": "codex-custom-magnifying-glass",
  "magnifying-glass-menu": "codex-custom-magnifying-glass-menu",
  marketplace: "codex-custom-marketplace",
  "maximize": "codex-native-arrow-up-right-arrow-down-left-sm-light-20",
  mcp: "codex-custom-mcp",
  bolt: "codex-custom-bolt",
  models: "codex-custom-models",
  monitor: "codex-20-101",
  "three-dots": "codex-custom-three-dots",
  "new-session": "codex-20-019",
  "new-session-active": "codex-20-019",
  openai: "codex-custom-openai",
  opencode: "codex-custom-opencode",
  "open-file": "codex-native-open-link-light-16",
  "outline-chevron-down": "codex-20-001",
  "outline-copy": "codex-custom-copy",
  "outline-share": "codex-20-083",
  "outline-sliders": "codex-20-079",
  "outline-xmark": "codex-custom-close",
  "page": "codex-native-document-light-20",
  "page-plus": "codex-custom-page-plus",
  pencil: "codex-20-019",
  "pencil-line": "codex-20-019",
  "photo": "codex-native-photo-light-20",
  pi: "codex-custom-pi",
  plus: "codex-20-006",
  "plus-small": "codex-20-006",
  prompt: "codex-20-153",
  providers: "codex-custom-providers",
  reload: "codex-20-004",
  reset: "codex-20-078",
  review: "codex-20-071",
  "review-active": "codex-20-071",
  "scroll-to-latest": "codex-20-002",
  server: "codex-20-127",
  send: "codex-custom-send",
  settings: "codex-20-051",
  "settings-gear": "codex-20-051",
  share: "codex-20-083",
  shield: "codex-20-116",
  sidebar: "codex-20-034",
  "sidebar-active": "codex-20-035",
  sliders: "codex-20-079",
  speech: "codex-20-153",
  "speech-bubble": "codex-20-153",
  split: "codex-custom-diff-split",
  "open-external": "codex-20-055",
  stop: "codex-custom-stop",
  task: "codex-20-139",
  terminal: "codex-20-050",
  "terminal-active": "codex-20-050",
  trash: "codex-20-080",
  unified: "codex-custom-diff-unified",
  warning: "codex-20-082",
  "window-cursor": "codex-native-web-browser-cursor-light-16",
  "workspace-new": "codex-native-folder-add",
  worktree: "codex-custom-worktree",
  "xmark-small": "codex-custom-close-small",
} as const satisfies Record<AppIconName, CodexGlyphName>

export const CODEX_ICON_TRANSFORMS = {
  "enter": "translate(20 0) scale(-1 1)",
  "arrow-right": "translate(20 0) scale(-1 1)",
  "chevron-double-left": "rotate(180 10 10)",
  "chevron-down": "rotate(90 10 10)",
  "chevron-left": "rotate(180 10 10)",
  copy: "translate(-2 -2) scale(1.2)",
  "layout-right-full": "rotate(180 10 10)",
  "layout-right-partial": "rotate(180 10 10)",
  "outline-chevron-down": "rotate(90 10 10)",
  "outline-copy": "translate(-2 -2) scale(1.2)",
  "scroll-to-latest": "rotate(180 10 10)",
} as const satisfies Partial<Record<AppIconName, string>>

export const codexIconLibrary = defineIconLibrary<AppIconName, CodexGlyphName>({
  name: "codex",
  glyphs: [...new Set(appIconNames.map((name) => CODEX_ICON_ALIASES[name]))],
  aliases: CODEX_ICON_ALIASES,
})
