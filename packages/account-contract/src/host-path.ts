/**
 * A directory on a machine, in the one form every side records and compares
 * it in: the machine's own absolute path, written as its platform writes it.
 * `/srv/app` on a POSIX host; `C:\work\app` or `\\server\share\app` on a
 * Windows host. The form is read from the path itself, never from the
 * platform of the process holding it: the owner names a Windows machine's
 * folder from a Mac, and the control plane stores both kinds.
 *
 * Text-only. The host repeats every containment check on the `realpath`,
 * which is where symlinks and junctions are resolved.
 */
export type HostPathKind = "posix" | "windows"

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
// `\\server\share` in either separator (`//server/share` is how a Windows
// shell spells it too), and not the `\\?\` and `\\.\` device namespaces,
// whose paths bypass normalization in the Win32 layer itself. A POSIX path
// starting with `//` names the same thing on no POSIX system that matters,
// while three or more slashes, or `//name` with no share, stay POSIX.
const WINDOWS_UNC = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]([^\\/]+)/

export function hostPathKind(path: string): HostPathKind | undefined {
  if (WINDOWS_DRIVE.test(path) || WINDOWS_UNC.test(path)) return "windows"
  if (path.startsWith("/")) return "posix"
  return undefined
}

/** `..` above the volume stays at the volume, as both kernels resolve it. */
function collapseDotSegments(segments: readonly string[]) {
  const kept: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      kept.pop()
      continue
    }
    kept.push(segment)
  }
  return kept
}

/**
 * Collapses `.`, `..`, empty segments and trailing separators. A POSIX path
 * keeps its spelling; a Windows path is written with `\`, its drive letter
 * upper-cased, and a volume root keeps its trailing `\` (`C:\`,
 * `\\server\share\`), the form the Win32 API and `realpath` answer with.
 * Undefined for a relative or empty path, and for a drive-relative one
 * (`C:app`), which names a different folder per process.
 */
export function normalizeHostPath(path: string): string | undefined {
  const kind = hostPathKind(path)
  if (kind === "posix") return `/${collapseDotSegments(path.split("/")).join("/")}`
  if (kind === undefined) return undefined
  const unified = path.replaceAll("/", "\\")
  const unc = WINDOWS_UNC.exec(unified)
  const volume = unc ? `\\\\${unc[1]}\\${unc[2]}` : `${unified.slice(0, 1).toUpperCase()}:`
  const rest = collapseDotSegments(unified.slice(volume.length).split("\\"))
  return rest.length === 0 ? `${volume}\\` : `${volume}\\${rest.join("\\")}`
}

/** The two normalized paths name one folder: byte-equal on POSIX, case-insensitive on Windows. */
export function hostPathEqual(a: string, b: string) {
  if (hostPathKind(a) !== "windows" || hostPathKind(b) !== "windows") return a === b
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Segment-aware containment: `/srv/api` is under `/srv`, `/srvx` is not;
 * `C:\work\api` is under `c:\Work`, `C:\workx` is not. A path and a root of
 * different kinds, or a root that is not absolute, admit nothing.
 */
export function hostPathWithin(path: string, root: string) {
  const inner = normalizeHostPath(path)
  const outer = normalizeHostPath(root)
  if (inner === undefined || outer === undefined) return false
  const kind = hostPathKind(inner)
  if (kind !== hostPathKind(outer)) return false
  if (kind === "posix") return outer === "/" || inner === outer || inner.startsWith(`${outer}/`)
  const under = inner.toLowerCase()
  const prefix = outer.toLowerCase()
  return under === prefix || under.startsWith(prefix.endsWith("\\") ? prefix : `${prefix}\\`)
}

export function hostPathWithinRoots(path: string, roots: readonly string[]) {
  return roots.some((root) => hostPathWithin(path, root))
}

function separator(kind: HostPathKind) {
  return kind === "posix" ? "/" : "\\"
}

/** The text left of a volume root's separator: nothing, a drive, or a UNC server and share. */
function isVolume(value: string, kind: HostPathKind) {
  if (kind === "posix") return value === ""
  if (/^[A-Za-z]:$/.test(value)) return true
  const unc = WINDOWS_UNC.exec(value)
  return unc !== null && unc[0].length === value.length
}

/** The directory holding a normalized path, or undefined at a volume root. */
export function hostPathParent(path: string): string | undefined {
  const kind = hostPathKind(path)
  if (kind === undefined) return undefined
  const sep = separator(kind)
  if (path.endsWith(sep)) return undefined
  const parent = path.slice(0, path.lastIndexOf(sep))
  return isVolume(parent, kind) ? `${parent}${sep}` : parent
}

/** `base` with `segments` appended in `base`'s own separator, normalized. */
export function hostPathJoin(base: string, segments: readonly string[]): string | undefined {
  const kind = hostPathKind(base)
  if (kind === undefined) return undefined
  return normalizeHostPath([base, ...segments].join(separator(kind)))
}

/** The last segment of a normalized path; empty at a volume root. */
export function hostPathBasename(path: string): string {
  const kind = hostPathKind(path)
  if (kind === undefined) return ""
  const sep = separator(kind)
  if (path.endsWith(sep)) return ""
  return path.slice(path.lastIndexOf(sep) + 1)
}
