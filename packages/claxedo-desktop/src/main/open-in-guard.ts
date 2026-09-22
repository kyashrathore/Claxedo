/**
 * Launch policy for the `open-path` IPC handler.
 *
 * The handler services `openPath(path, app)` with `execFile(app, [path])` (and
 * `open -a app path` on macOS), so an unconstrained `app` is arbitrary command
 * execution from the renderer. The renderer is not a trusted source for it:
 * every document the preload runs on holds the same bridge. No renderer surface
 * passes an `app` today — the file links in the timeline and the terminal ask
 * for the path alone — so the allowlist in `./open-in-apps.ts` is what the
 * channel grants rather than a mirror of anything the UI offers.
 *
 * Kept free of electron imports so it is directly testable.
 *
 * The path is checked in two steps. Main holds no registry of workspace roots
 * — the session directory is renderer knowledge, read from the server — so
 * there is no root set to test containment against, and one the renderer
 * declared per call would prove nothing. What is enforceable is the shape of
 * the path, and it is what keeps the channel at "open this exact location":
 * a relative path would resolve against main's own cwd rather than the
 * caller's, a `..` component walks out of the directory the request names,
 * and a leading `-` is read by `open` and by every editor CLI as a flag rather
 * than a path.
 *
 * The second step reads what the path is on disk, because what happens next
 * depends on it and not on the spelling: a directory is revealed or opened in
 * a tool, a document is handed to its OS handler, and anything the OS handler
 * or a terminal would *run* — a script by extension, a file with an execute
 * bit, a `.app` bundle — is either refused (terminals) or held for the user's
 * explicit confirmation (OS handler). Symlinks are resolved first so a link
 * named `notes.md` cannot stand in for the script it points at.
 */
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import { OPEN_IN_APPS, openInApp, type OpenInApp } from "./open-in-apps"

export type OpenInResolution = {
  platform: NodeJS.Platform
  resolveAppPath: (name: string) => Promise<string | null>
}

export type OpenInAction =
  | { kind: "reveal"; path: string }
  | { kind: "open-document"; path: string }
  | { kind: "open-executable"; path: string }
  | { kind: "launch"; app: string; path: string }

export type OpenInRefusal = { allowed: false; reason: string }

export type OpenInVerdict = { allowed: true; action: OpenInAction } | OpenInRefusal

type OpenTarget =
  | { kind: "directory"; executable: boolean }
  | { kind: "file"; executable: boolean }
  | { kind: "other" }
  | { kind: "missing" }

export async function resolveOpenInApp(app: string, deps: OpenInResolution): Promise<OpenInApp | null> {
  const listed = openInApp(app)
  if (listed) return listed
  // Windows arrives pre-resolved: `renderer/shell.tsx`'s `openPath` swaps the
  // app name for whatever `resolve-app-path` found, so the name never reaches
  // this process. Re-resolve the allowlist and compare executables instead.
  if (deps.platform !== "win32") return null
  const target = app.toLowerCase()
  for (const entry of OPEN_IN_APPS) {
    const resolved = await deps.resolveAppPath(entry.name).catch(() => null)
    if (resolved && resolved.toLowerCase() === target) return entry
  }
  return null
}

const CONTROL_CHARACTER = /[\u0000-\u001f]/

export function openInPathVerdict(target: string, platform: NodeJS.Platform): { allowed: true } | OpenInRefusal {
  if (!target) return { allowed: false, reason: "empty path" }
  // A NUL truncates the string at the syscall, so what the OS opens stops
  // being what was checked here.
  if (CONTROL_CHARACTER.test(target)) return { allowed: false, reason: "path contains a control character" }
  if (target.startsWith("-")) return { allowed: false, reason: "path would be read as an option" }

  const windows = platform === "win32"
  if (!(windows ? path.win32 : path.posix).isAbsolute(target)) {
    return { allowed: false, reason: "path is not absolute" }
  }

  // Segments rather than a `normalize` comparison: on Windows `normalize` also
  // rewrites separator style, so that comparison would reject the valid
  // `C:/projects/app`.
  const segments = target.split(windows ? /[\\/]/ : /\//)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { allowed: false, reason: "path leaves the directory it names" }
  }

  return { allowed: true }
}

/**
 * Names whose OS handler runs the file rather than displaying it. `.app` is a
 * directory to `lstat` and a program to Launch Services, which is why the
 * extension is consulted for directories too.
 */
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".command",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".com",
  ".exe",
  ".msi",
  ".scr",
  ".vbs",
  ".wsf",
  ".hta",
  ".app",
  ".scpt",
  ".jar",
  ".pkg",
])

function executableName(target: string, platform: NodeJS.Platform) {
  const extname = (platform === "win32" ? path.win32 : path.posix).extname(target).toLowerCase()
  return EXECUTABLE_EXTENSIONS.has(extname)
}

async function inspectOpenTarget(target: string, platform: NodeJS.Platform): Promise<OpenTarget> {
  let stat = await lstat(target).catch(() => null)
  if (!stat) return { kind: "missing" }
  let resolved = target
  if (stat.isSymbolicLink()) {
    const real = await realpath(target).catch(() => null)
    if (!real) return { kind: "missing" }
    resolved = real
    stat = await lstat(resolved).catch(() => null)
    if (!stat) return { kind: "missing" }
  }
  const scripted = executableName(target, platform) || executableName(resolved, platform)
  if (stat.isDirectory()) return { kind: "directory", executable: scripted }
  if (!stat.isFile()) return { kind: "other" }
  // libuv derives a Windows file's mode from the read-only attribute alone and
  // never sets an execute bit there, so on that platform the extension set is
  // the whole test.
  return { kind: "file", executable: scripted || (stat.mode & 0o111) !== 0 }
}

export async function openInVerdict(
  request: { path: string; app?: string },
  deps: OpenInResolution,
): Promise<OpenInVerdict> {
  const pathVerdict = openInPathVerdict(request.path, deps.platform)
  if (!pathVerdict.allowed) return pathVerdict

  const target = await inspectOpenTarget(request.path, deps.platform)
  if (target.kind === "missing") return { allowed: false, reason: "path does not exist" }
  if (target.kind === "other") return { allowed: false, reason: "path is neither a file nor a directory" }

  if (request.app === undefined) {
    if (target.executable) return { allowed: true, action: { kind: "open-executable", path: request.path } }
    if (target.kind === "directory") return { allowed: true, action: { kind: "reveal", path: request.path } }
    return { allowed: true, action: { kind: "open-document", path: request.path } }
  }

  const app = await resolveOpenInApp(request.app, deps)
  if (!app) return { allowed: false, reason: `app "${request.app}" is not on the open-path allowlist` }
  if (app.kind === "terminal" && (target.kind !== "directory" || target.executable)) {
    return { allowed: false, reason: `"${app.name}" opens directories only; it would run a file it is given` }
  }
  return { allowed: true, action: { kind: "launch", app: request.app, path: request.path } }
}
