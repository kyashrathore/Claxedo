import { isBase64Url } from "@claxedo/account-contract/machine"

/** |server now − x-claxedo-host-ts| above this is refused. */
export const MACHINE_REQUEST_SKEW_MS = 60_000
/** A consumed nonce stays refused for this long after its `ts`; it outlives the skew window on both sides. */
export const MACHINE_NONCE_TTL_MS = 120_000
export const MACHINE_NONCE_MIN_LENGTH = 16
export const MACHINE_NONCE_MAX_LENGTH = 64

export function isMachineNonce(value: string) {
  return value.length >= MACHINE_NONCE_MIN_LENGTH && value.length <= MACHINE_NONCE_MAX_LENGTH && isBase64Url(value)
}

/**
 * Collapses `.`, `..`, empty segments and trailing slashes of an absolute
 * POSIX path; `..` above the root stays at the root, as the kernel resolves
 * it. Undefined for a relative or empty path. Text-only: the host repeats
 * the check on the `realpath`, which is where symlinks are resolved.
 */
export function normalizePosixDirectory(input: string): string | undefined {
  if (!input.startsWith("/")) return undefined
  const segments: string[] = []
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join("/")}`
}

/**
 * The form a workspace's directory is recorded in by every authority backend:
 * an absolute POSIX path normalized as above, so `/srv/app/` and `/srv/app`
 * are one row and a stored value can be compared to a root by plain prefix.
 * Anything else — a Windows path on an account machine — is recorded as given.
 */
export function normalizeStoredDirectory(input: string): string {
  return normalizePosixDirectory(input) ?? input
}

/**
 * The P1.4 root rule: `directory` is one of `roots` or under one of them,
 * segment-aware (`/srv/api` is under `/srv`; `/srvx` is not). Empty roots
 * admit nothing; a root that is not an absolute path admits nothing.
 */
export function directoryWithinRoots(directory: string, roots: readonly string[]): boolean {
  const target = normalizePosixDirectory(directory)
  if (target === undefined) return false
  return roots.some((candidate) => {
    const root = normalizePosixDirectory(candidate)
    if (root === undefined) return false
    return target === root || target.startsWith(root === "/" ? "/" : `${root}/`)
  })
}
