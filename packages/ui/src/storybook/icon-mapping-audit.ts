/** Each proposal is constrained to the family of the column that renders it. */
export type NativeCodexProposal = { native: string; flipX?: boolean }
export type OpenCodeProposal =
  | { library: "opencode"; name: "review" | "checklist"; version?: never }
  | { library: "opencode"; version: "v2"; name: "expand" | "collapse" | "split" | "unified" | "monitor" }
  | { library: "opencode"; draft: "folder-stack" | "document-text" }

export { OPEN_CODE_CUSTOM_ARTWORK as openCodeDraftArtwork } from "../components/opencode-custom-artwork"

export const appliedIconReplacements: Partial<
  Record<string, { codex?: NativeCodexProposal; opencode?: OpenCodeProposal }>
> = {
  changes: {
    opencode: {
      library: "opencode",
      name: "review",
    },
  },
  task: {
    opencode: {
      library: "opencode",
      name: "checklist",
    },
  },
  "align-right": {
    codex: {
      native: "arrow-forward-line-vertical-light-16",
    },
  },
  "arrow-right": {
    codex: {
      native: "arrow-left-lg-light-20",
      flipX: true,
    },
  },
  "circle-check": {
    codex: {
      native: "checkmark-circle-light-16",
    },
  },
  "circle-dashed": {
    codex: {
      native: "circle-dashed",
    },
  },
  cloud: {
    codex: {
      native: "cloud-light-16",
    },
  },
  "cloud-upload": {
    codex: {
      native: "cloud-upload",
    },
  },
  enter: {
    codex: {
      native: "arrow-curved-right-large-typographic-light-20",
      flipX: true,
    },
  },
  eye: {
    codex: {
      native: "eye-light-20",
    },
  },
  keyboard: {
    codex: {
      native: "keyboard-light-20",
    },
  },
  "layout-bottom": {
    codex: {
      native: "dock-light-16",
    },
  },
  link: {
    codex: {
      native: "link-light-16",
    },
  },
  "open-file": {
    codex: {
      native: "open-link-light-16",
    },
  },
  page: {
    codex: {
      native: "document-light-20",
    },
  },
  photo: {
    codex: {
      native: "photo-light-20",
    },
  },
  "workspace-new": {
    codex: {
      native: "folder-add",
    },
  },
  "document-text": {
    codex: {
      native: "text-document-light-20",
    },
    opencode: {
      library: "opencode",
      draft: "document-text",
    },
  },
  "window-cursor": {
    codex: {
      native: "web-browser-cursor-light-16",
    },
  },
  "expand-all": {
    opencode: {
      library: "opencode",
      version: "v2",
      name: "expand",
    },
  },
  "collapse-all": {
    opencode: {
      library: "opencode",
      version: "v2",
      name: "collapse",
    },
  },
  split: {
    opencode: {
      library: "opencode",
      version: "v2",
      name: "split",
    },
  },
  unified: {
    opencode: {
      library: "opencode",
      version: "v2",
      name: "unified",
    },
  },
  monitor: {
    opencode: {
      library: "opencode",
      version: "v2",
      name: "monitor",
    },
  },
  maximize: {
    codex: {
      native: "arrow-up-right-arrow-down-left-sm-light-20",
    },
  },
  folders: {
    codex: {
      native: "folder-on-folder-light-16",
    },
    opencode: {
      library: "opencode",
      draft: "folder-stack",
    },
  },
}

export type IconMappingAudit = {
  status: "fix" | "decision" | "accepted" | "applied"
  affected: readonly ("codex" | "opencode")[]
  observed: { codex: string; opencode: string }
  expected: string
  reason: string
}

export const iconMappingAudit: Partial<Record<string, IconMappingAudit>> = {
  "align-right": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native align right artwork",
      opencode: "Right arrow ending at a vertical bar",
    },
    expected: "Arrow ending at a right alignment boundary",
    reason: "Approved artwork applied to the production renderer. Arrow ending at a right alignment boundary",
  },
  "arrow-down-to-line": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Down arrow landing in a tray",
      opencode: "Plain down arrow WITHOUT a landing line",
    },
    expected: "Down arrow landing on a horizontal line",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  "arrow-right": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native arrow right artwork",
      opencode: "Right arrow",
    },
    expected: "Plain right-pointing arrow",
    reason: "Approved artwork applied to the production renderer. Plain right-pointing arrow",
  },
  "chevron-double-left": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Single left chevron",
      opencode: "Two left chevrons",
    },
    expected: "Two chevrons in the named direction",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  "chevron-double-right": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Single right chevron",
      opencode: "Two right chevrons",
    },
    expected: "Two chevrons in the named direction",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  "circle-ban-sign": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "X in a circle",
      opencode: "Circle with a diagonal slash",
    },
    expected: "Circle with a diagonal prohibition slash",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  "circle-check": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native circle check artwork",
      opencode: "Checkmark in a circle",
    },
    expected: "Checkmark enclosed by a circle",
    reason: "Approved artwork applied to the production renderer. Checkmark enclosed by a circle",
  },
  "circle-dashed": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native circle dashed artwork",
      opencode: "Dashed circular outline",
    },
    expected: "Dashed circular outline",
    reason: "Approved artwork applied to the production renderer. Dashed circular outline",
  },
  claude: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "claude brand mark",
      opencode: "claude brand mark",
    },
    expected: "One official brand mark shared by both themes.",
    reason:
      "Harness brands resolve from HARNESS_BRAND_ARTWORK. Theme changes never substitute a generic interface symbol.",
  },
  cloud: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native cloud artwork",
      opencode: "Native cloud artwork",
    },
    expected: "Same artwork in both themes.",
    reason: "User approved codex artwork shared across both themes.",
  },
  "cloud-upload": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native cloud upload artwork",
      opencode: "Cloud containing an up arrow",
    },
    expected: "Cloud with an upward arrow",
    reason: "Approved artwork applied to the production renderer. Cloud with an upward arrow",
  },
  "code-lines": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Scroll / rolled document with text",
      opencode: "Three rows of broken horizontal lines",
    },
    expected: "Horizontal code/text lines",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  "collapse-all": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Inward vertical arrows beside document lines",
      opencode: "Inward vertical arrows around a horizontal line",
    },
    expected: "Vertical collapse/expand with a collection or line cue",
    reason:
      "Approved artwork applied to the production renderer. Vertical collapse/expand with a collection or line cue",
  },
  cursor: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "cursor brand mark",
      opencode: "cursor brand mark",
    },
    expected: "One official brand mark shared by both themes.",
    reason:
      "Harness brands resolve from HARNESS_BRAND_ARTWORK. Theme changes never substitute a generic interface symbol.",
  },
  changes: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Rounded box containing plus and minus",
      opencode: "Plus and minus in a square",
    },
    expected: "Recognizable diff/change mark, distinct from code lines",
    reason:
      "Approved artwork applied to the production renderer. Recognizable diff/change mark, distinct from code lines",
  },
  discord: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Discord controller-face mark",
      opencode: "Discord controller-face mark",
    },
    expected: "Same artwork in both themes.",
    reason: "User approved opencode artwork shared across both themes.",
  },
  enter: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native enter artwork",
      opencode: "Hooked Return / Enter arrow",
    },
    expected: "Hooked Enter/Return arrow",
    reason: "Approved artwork applied to the production renderer. Hooked Enter/Return arrow",
  },
  "expand-all": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Outward vertical arrows beside document lines",
      opencode: "Outward vertical arrows around a horizontal line",
    },
    expected: "Vertical collapse/expand with a collection or line cue",
    reason:
      "Approved artwork applied to the production renderer. Vertical collapse/expand with a collection or line cue",
  },
  eye: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native eye artwork",
      opencode: "Eye",
    },
    expected: "Eye",
    reason: "Approved artwork applied to the production renderer. Eye",
  },
  "folder-open": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Open folder",
      opencode: "Folder on folder",
    },
    expected: "Theme-specific project folder artwork.",
    reason: "User approved OpenCode folders artwork here; Codex keeps its open-folder drawing.",
  },
  folders: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Folder on folder",
      opencode: "Folder on folder",
    },
    expected: "One folders icon; active state uses emphasis without a duplicate icon name.",
    reason: "User-approved consolidated folders identity.",
  },
  gauge: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Speedometer / gauge",
      opencode: "Speedometer / gauge",
    },
    expected: "Same artwork in both themes.",
    reason: "User approved codex artwork shared across both themes.",
  },
  glasses: {
    status: "fix",
    affected: ["codex"],
    observed: {
      codex: "Open book",
      opencode: "Eyeglasses",
    },
    expected: "Eyeglasses",
    reason: "The artwork is an open book.",
  },
  globe: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Globe",
      opencode: "Globe",
    },
    expected: "Same artwork in both themes.",
    reason: "User approved codex artwork shared across both themes.",
  },
  keyboard: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native keyboard artwork",
      opencode: "Keyboard with keys",
    },
    expected: "Keyboard",
    reason: "Approved artwork applied to the production renderer. Keyboard",
  },
  "layout-bottom": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native layout bottom artwork",
      opencode: "Window with a bottom strip",
    },
    expected: "Window with a bottom strip and the requested emphasis",
    reason:
      "Approved artwork applied to the production renderer. Window with a bottom strip and the requested emphasis",
  },
  "layout-right-full": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Window with a complete right-side divider",
      opencode: "Window with its large RIGHT content area filled, leaving a narrow left column",
    },
    expected: "Mirror the left layout into a narrow right sidebar",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  "layout-right-partial": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Window with a narrow right-side indicator",
      opencode: "Window with a narrow LEFT column and subtly filled large right area",
    },
    expected: "Mirror the left layout into a narrow right sidebar",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  link: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native link artwork",
      opencode: "Chain link",
    },
    expected: "Chain link",
    reason: "Approved artwork applied to the production renderer. Chain link",
  },
  monitor: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Laptop",
      opencode: "Desktop display and stand",
    },
    expected: "Desktop monitor/display",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  "new-session-active": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Pencil",
      opencode: "Pencil on a square with subtle active fill",
    },
    expected:
      "Document whether foreground alone carries the active state; add a distinct glyph only where required by the feature.",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  openai: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "openai brand mark",
      opencode: "openai brand mark",
    },
    expected: "One official brand mark shared by both themes.",
    reason:
      "Harness brands resolve from HARNESS_BRAND_ARTWORK. Theme changes never substitute a generic interface symbol.",
  },
  opencode: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "opencode brand mark",
      opencode: "opencode brand mark",
    },
    expected: "One official brand mark shared by both themes.",
    reason:
      "Harness brands resolve from HARNESS_BRAND_ARTWORK. Theme changes never substitute a generic interface symbol.",
  },
  "open-file": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native open file artwork",
      opencode: "Northeast arrow emerging from a square",
    },
    expected: "Open-file action, distinct from finding/searching a file",
    reason:
      "Approved artwork applied to the production renderer. Open-file action, distinct from finding/searching a file",
  },
  page: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native page artwork",
      opencode: "Blank document with a folded corner",
    },
    expected: "Plain page/document",
    reason: "Approved artwork applied to the production renderer. Plain page/document",
  },
  photo: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native photo artwork",
      opencode: "Landscape/photo frame",
    },
    expected: "Landscape/image frame",
    reason: "Approved artwork applied to the production renderer. Landscape/image frame",
  },
  pi: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "pi brand mark",
      opencode: "pi brand mark",
    },
    expected: "One official brand mark shared by both themes.",
    reason:
      "Harness brands resolve from HARNESS_BRAND_ARTWORK. Theme changes never substitute a generic interface symbol.",
  },
  process: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Bare >_ prompt",
      opencode: "Bare >_ prompt",
    },
    expected:
      "Process and terminal share OpenCode’s >_ artwork across all themes.",
    reason: "ICON_ARTWORK_POLICY selects OpenCode for process and both terminal states; PROCESS_ICON_GLYPHS maps process to terminal.",
  },
  reload: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Two circular reload arrows",
      opencode: "Two circular reload arrows",
    },
    expected: "Same artwork in both themes.",
    reason: "User approved codex artwork shared across both themes.",
  },
  reset: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Circular reset / undo arrow",
      opencode: "Circular reset / undo arrow",
    },
    expected: "Same artwork in both themes.",
    reason: "User approved codex artwork shared across both themes.",
  },
  "review-active": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Rounded box containing plus and minus",
      opencode: "Plus and minus in a subtly filled square",
    },
    expected:
      "Document whether foreground alone carries the active state; add a distinct glyph only where required by the feature.",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  server: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Buildings / skyline",
      opencode: "Server enclosure with indicators",
    },
    expected: "Server enclosure/rack",
    reason: "Accepted as-is for now by the user (2026-09-09); documented at the mapping source.",
  },
  split: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Side-by-side red and green diff columns",
      opencode: "Two equal diff columns",
    },
    expected: "Two-column and single-column diff presentation",
    reason: "Approved artwork applied to the production renderer. Two-column and single-column diff presentation",
  },
  subagent: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Brain",
      opencode: "Nested squares",
    },
    expected:
      "Keep the theme-specific subagent metaphor. Resolve it from PROCESS_ICON_GLYPHS rather than choosing artwork at each caller.",
    reason: "Centralized ownership; these are agent glyphs, not the symbol for a general shell process.",
  },
  task: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Checklist: tick, circle and horizontal lines",
      opencode: "Checklist",
    },
    expected: "Task/checklist/checkable item",
    reason: "Approved artwork applied to the production renderer. Task/checklist/checkable item",
  },
  "terminal-active": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Bare >_ prompt",
      opencode: "Bare >_ prompt",
    },
    expected:
      "Both themes use the same bare >_ prompt in both states; only foreground emphasis changes.",
    reason: "The shared artwork policy keeps both terminal states on OpenCode artwork in every theme.",
  },
  unified: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Stacked red and green diff lines",
      opencode: "One column with stacked diff rows",
    },
    expected: "Two-column and single-column diff presentation",
    reason: "Approved artwork applied to the production renderer. Two-column and single-column diff presentation",
  },
  "window-cursor": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Browser window and pointer",
      opencode: "Pointer over a window",
    },
    expected: "A browser window with a pointer for web-content tool rows; inspect-element owns the picker action.",
    reason:
      "Approved artwork applied to the production renderer. A browser window with a pointer for web-content tool rows; inspect-element owns the picker action.",
  },
  "workspace-new": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Native workspace new artwork",
      opencode: "Folder with a plus",
    },
    expected: "Workspace/folder with an add cue",
    reason: "Approved artwork applied to the production renderer. Workspace/folder with an add cue",
  },
  worktree: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Trunk branching into two arrows",
      opencode: "Trunk branching into two arrows",
    },
    expected: "Same artwork in both themes.",
    reason: "User approved codex artwork shared across both themes.",
  },
  "three-dots": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Three horizontal dots",
      opencode: "Three horizontal square dots",
    },
    expected: "Renamed dot-grid to three-dots for overflow menus; kept each theme’s own dot shape.",
    reason: "Naming decision applied to the shared APIs and callers.",
  },
  "folder-add": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Folder with a plus",
      opencode: "Folder with a plus",
    },
    expected: "Renamed grid-plus and folder-add-left to folder-add. Both mappings depict adding a folder.",
    reason: "Naming decision applied to the shared APIs and callers.",
  },
  "document-text": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Document with text lines",
      opencode: "Document with text lines",
    },
    expected: "Document with visible text lines in both themes.",
    reason: "Approved artwork applied to the production renderer. Document with visible text lines in both themes.",
  },
  "open-external": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Bare arrow pointing northeast",
      opencode: "Northeast arrow emerging from a square",
    },
    expected:
      "Merged square-arrow-top-right and outline-square-arrow into open-external. Bare and framed northeast arrows are both valid for this action.",
    reason: "Naming decision applied to the shared APIs and callers.",
  },
  "inspect-element": {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Clicking pointer with radiating marks",
      opencode: "Pointer over a window",
    },
    expected: "Element picker uses inspect-element: clicking pointer in Codex, pointer over a window in OpenCode.",
    reason:
      "The browser picker now names its action. The style difference is intentional and the renderer stays in the selected theme.",
  },
  maximize: {
    status: "accepted",
    affected: [],
    observed: {
      codex: "Outward diagonal arrows",
      opencode: "Outward diagonal arrows",
    },
    expected: "Arrows with shafts for maximize.",
    reason: "Approved artwork applied to the production renderer. Arrows with shafts for maximize.",
  },
}
