/**
 * Launch policy for the `open-path` IPC handler.
 *
 * The handler services `openPath(path, app)` with `execFile(app, [path])` (and
 * `open -a app path` on macOS), so an unconstrained `app` is arbitrary command
 * execution from the renderer. The renderer is not a trusted source for it:
 * every document the preload runs on holds the same bridge, and the value
 * originates in a UI menu whose contents are known ahead of time — so an
 * allowlist of exactly the apps that menu offers loses nothing.
 *
 * The list itself lives with the menu (`@claxedo/app/open-in-targets`) so a new
 * target cannot be added to one side alone. Kept free of electron imports so it
 * is directly testable.
 *
 * The path is checked too, but note what that check is and is not. Main holds
 * no registry of workspace roots — the session directory is renderer knowledge,
 * read from the server — so there is no root set to test containment against,
 * and one the renderer declared per call would prove nothing. What is
 * enforceable is the shape of the path, and it is what keeps the channel at
 * "open this exact location", the privilege the menu means to grant: a relative
 * path would resolve against main's own cwd rather than the caller's, a `..`
 * component walks out of the directory the request names, and a leading `-` is
 * read by `open` and by every editor CLI as a flag rather than a path.
 */
import path from "node:path"

import { isOpenInAppName, OPEN_IN_APP_NAMES } from "@claxedo/app/open-in-targets"

export type OpenInResolution = {
  platform: NodeJS.Platform
  resolveAppPath: (name: string) => Promise<string | null>
}

export type OpenInVerdict = { allowed: true } | { allowed: false; reason: string }

export async function isAllowedOpenInTarget(app: string, deps: OpenInResolution): Promise<boolean> {
  if (isOpenInAppName(app)) return true
  // Windows arrives pre-resolved: `renderer/shell.tsx`'s `openPath` swaps the
  // app name for whatever `resolve-app-path` found, so the name never reaches
  // this process. Re-resolve the allowlist and compare executables instead.
  if (deps.platform !== "win32") return false
  const target = app.toLowerCase()
  for (const name of OPEN_IN_APP_NAMES) {
    const resolved = await deps.resolveAppPath(name).catch(() => null)
    if (resolved && resolved.toLowerCase() === target) return true
  }
  return false
}

const CONTROL_CHARACTER = /[\u0000-\u001f]/

export function openInPathVerdict(target: string, platform: NodeJS.Platform): OpenInVerdict {
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

export async function openInVerdict(
  request: { path: string; app?: string },
  deps: OpenInResolution,
): Promise<OpenInVerdict> {
  const pathVerdict = openInPathVerdict(request.path, deps.platform)
  if (!pathVerdict.allowed) return pathVerdict
  if (request.app === undefined) return { allowed: true }
  if (await isAllowedOpenInTarget(request.app, deps)) return { allowed: true }
  return { allowed: false, reason: `app "${request.app}" is not an Open in… target` }
}
