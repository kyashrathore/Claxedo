import { sep } from "node:path"

/**
 * Purely lexical containment check on two ALREADY-RESOLVED absolute paths. The
 * root itself counts as inside; a sibling that merely shares the root as a
 * string prefix (/a/workspace-old under root /a/workspace) does not.
 *
 * It performs no normalisation of its own — no resolve, no realpath, no
 * trailing-separator trimming, no case folding. Every caller is responsible for
 * passing `path.resolve`'d values and, where the check is a security boundary,
 * `fs.realpath`'d ones.
 */
export function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}
