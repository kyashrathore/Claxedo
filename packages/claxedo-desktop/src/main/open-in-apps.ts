/**
 * The programs `open-path` will launch, and what each may be handed.
 *
 * One flat union rather than a table per platform: the handler resolves the
 * name through `execFile`/`open -a`, which only ever asks "is this on the
 * list", and a per-platform split would let a caller on one platform be
 * refused a spelling the same binary answers to on another. macOS launches the
 * bundle name ("Visual Studio Code"), Windows and Linux the executable
 * ("code"), so both spellings are here for the same editor.
 *
 * `kind` is the other half of the grant. An editor shows the path it is given,
 * so it may take a file or a directory. A terminal runs what it is given —
 * `open -a Terminal x.command`, iTerm and Ghostty with a shell script, and
 * `powershell x.ps1` all execute the file — so it takes a directory only.
 *
 * Adding a name here grants the renderer one more program it can start, so
 * every entry is an editor, terminal or IDE a user asked to open a project
 * directory in — nothing that takes a command to run.
 */

export type OpenInAppKind = "editor" | "terminal"

export type OpenInApp = { name: string; kind: OpenInAppKind }

export const OPEN_IN_APPS: readonly OpenInApp[] = [
  { name: "Visual Studio Code", kind: "editor" },
  { name: "Cursor", kind: "editor" },
  { name: "Zed", kind: "editor" },
  { name: "TextMate", kind: "editor" },
  { name: "Antigravity", kind: "editor" },
  { name: "Terminal", kind: "terminal" },
  { name: "iTerm", kind: "terminal" },
  { name: "Ghostty", kind: "terminal" },
  { name: "Warp", kind: "terminal" },
  { name: "Xcode", kind: "editor" },
  { name: "Android Studio", kind: "editor" },
  { name: "Sublime Text", kind: "editor" },
  { name: "code", kind: "editor" },
  { name: "cursor", kind: "editor" },
  { name: "zed", kind: "editor" },
  { name: "powershell", kind: "terminal" },
]

export function openInApp(name: string): OpenInApp | undefined {
  return OPEN_IN_APPS.find((app) => app.name === name)
}
