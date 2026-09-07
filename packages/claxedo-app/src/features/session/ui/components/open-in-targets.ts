/**
 * The apps the session header offers for "Open in…", and the only app names
 * Electron main will launch for `open-path`.
 *
 * Exported from `@claxedo/app` as `./open-in-targets` so the desktop's
 * `main/open-in-guard.ts` enforces the same set the menu offers: main services
 * the request with `execFile(app, [path])`, so a list that drifts from this one
 * is either a dead menu entry or an unreviewed launch primitive. Keep this
 * module free of imports — it is walked into the Electron main closure.
 */

export type OpenInOS = "macos" | "windows" | "linux" | "unknown"

/** Subset of `@opencode-ai/ui`'s `AppIcon` ids; `AppIcon id={…}` checks it. */
export type OpenInIcon =
  | "vscode"
  | "cursor"
  | "zed"
  | "textmate"
  | "antigravity"
  | "terminal"
  | "iterm2"
  | "ghostty"
  | "warp"
  | "xcode"
  | "android-studio"
  | "sublime-text"
  | "powershell"
  | "finder"
  | "file-explorer"

export type OpenInTarget = {
  id: string
  labelKey: string
  icon: OpenInIcon
  /** Passed to `platform.openPath` as the app to launch the directory with. */
  openWith: string
}

const MACOS_TARGETS = [
  { id: "vscode", labelKey: "session.header.open.app.vscode", icon: "vscode", openWith: "Visual Studio Code" },
  { id: "cursor", labelKey: "session.header.open.app.cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", labelKey: "session.header.open.app.zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", labelKey: "session.header.open.app.textmate", icon: "textmate", openWith: "TextMate" },
  {
    id: "antigravity",
    labelKey: "session.header.open.app.antigravity",
    icon: "antigravity",
    openWith: "Antigravity",
  },
  { id: "terminal", labelKey: "session.header.open.app.terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", labelKey: "session.header.open.app.iterm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", labelKey: "session.header.open.app.ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", labelKey: "session.header.open.app.warp", icon: "warp", openWith: "Warp" },
  { id: "xcode", labelKey: "session.header.open.app.xcode", icon: "xcode", openWith: "Xcode" },
  {
    id: "android-studio",
    labelKey: "session.header.open.app.androidStudio",
    icon: "android-studio",
    openWith: "Android Studio",
  },
  {
    id: "sublime-text",
    labelKey: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const satisfies readonly OpenInTarget[]

const WINDOWS_TARGETS = [
  { id: "vscode", labelKey: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", labelKey: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", labelKey: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "powershell",
    labelKey: "session.header.open.app.powershell",
    icon: "powershell",
    openWith: "powershell",
  },
  {
    id: "sublime-text",
    labelKey: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const satisfies readonly OpenInTarget[]

const LINUX_TARGETS = [
  { id: "vscode", labelKey: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", labelKey: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", labelKey: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "sublime-text",
    labelKey: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const satisfies readonly OpenInTarget[]

export function openInTargets(os: OpenInOS): readonly OpenInTarget[] {
  if (os === "macos") return MACOS_TARGETS
  if (os === "windows") return WINDOWS_TARGETS
  return LINUX_TARGETS
}

/**
 * The OS file manager. It launches through `shell.openPath` with no app name,
 * so it is a menu entry without an `openWith` and never reaches the allowlist.
 */
export function fileManagerTarget(os: OpenInOS): { id: string; labelKey: string; icon: OpenInIcon } {
  if (os === "macos") return { id: "finder", labelKey: "session.header.open.finder", icon: "finder" }
  if (os === "windows") {
    return { id: "finder", labelKey: "session.header.open.fileExplorer", icon: "file-explorer" }
  }
  return { id: "finder", labelKey: "session.header.open.fileManager", icon: "finder" }
}

/** Every `openWith` across all three tables — the launch allowlist. */
export const OPEN_IN_APP_NAMES: readonly string[] = [
  ...new Set([...MACOS_TARGETS, ...WINDOWS_TARGETS, ...LINUX_TARGETS].map((target) => target.openWith)),
]

export function isOpenInAppName(app: string): boolean {
  return OPEN_IN_APP_NAMES.includes(app)
}
