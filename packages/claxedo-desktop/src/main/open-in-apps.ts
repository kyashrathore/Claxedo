/**
 * The app names `open-path` will launch.
 *
 * One flat union rather than a table per platform: the handler resolves the
 * name through `execFile`/`open -a`, which only ever asks "is this on the
 * list", and a per-platform split would let a caller on one platform be
 * refused a spelling the same binary answers to on another. macOS launches the
 * bundle name ("Visual Studio Code"), Windows and Linux the executable
 * ("code"), so both spellings are here for the same editor.
 *
 * Adding a name here grants the renderer one more program it can start, so
 * every entry is an editor, terminal or IDE a user asked to open a project
 * directory in — nothing that takes a command to run.
 */

export const OPEN_IN_APP_NAMES: readonly string[] = [
  "Visual Studio Code",
  "Cursor",
  "Zed",
  "TextMate",
  "Antigravity",
  "Terminal",
  "iTerm",
  "Ghostty",
  "Warp",
  "Xcode",
  "Android Studio",
  "Sublime Text",
  "code",
  "cursor",
  "zed",
  "powershell",
]

export function isOpenInAppName(app: string): boolean {
  return OPEN_IN_APP_NAMES.includes(app)
}
