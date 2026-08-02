/**
 * Containment check for agent transcript paths before we read them.
 *
 * The path originates in a harness hook payload (`transcript_path` in Claude
 * Code / Codex / Gemini / Cursor notify hooks), travels as a query param through
 * the workspace runtime's `/api/wr/hook/agent-lifecycle` route, and is stored
 * verbatim. Only a `.trim()` was applied anywhere along the way, so by the time
 * `session_messages` falls back to reading it, an attacker who can reach the
 * hook route chooses an arbitrary absolute path and gets the file's last 60 KB
 * echoed back through the MCP tool.
 *
 * The containment rule is NOT "inside the workspace": real transcripts live in
 * per-harness home directories (`~/.claude/projects/**`, `~/.codex/sessions/**`)
 * and never inside the repo, so a workspace-prefix check would reject every
 * legitimate read. Instead a path must sit under one of the allowed roots (home
 * or the workspace directory) AND outside the credential-shaped subtrees that
 * happen to live under home too — `~/.ssh`, `~/.aws`, cloud/CI credential
 * stores, and the auth files our own harnesses write.
 */

import os from "node:os"
import path from "node:path"

/** Directory names anywhere in the path that are never transcript territory. */
const DENIED_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".gcloud",
  ".config/gcloud",
  ".npmrc",
  ".netrc",
])

/** Basenames that are credential material regardless of where they sit. */
const DENIED_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  ".git-credentials",
])

export type TranscriptPathRefusal = Readonly<{ ok: false; reason: string }>
export type TranscriptPathAllowed = Readonly<{ ok: true; path: string }>
export type TranscriptPathVerdict = TranscriptPathAllowed | TranscriptPathRefusal

/**
 * Resolve `candidate` and decide whether it may be read as a transcript.
 *
 * `roots` defaults to the user's home directory plus `workspaceDirectory` when
 * that is a real filesystem path (it can also be a `workspace:<id>` ref, which
 * names no local directory and is therefore skipped).
 */
export function resolveTranscriptPath(
  candidate: string,
  options: Readonly<{ workspaceDirectory?: string; homeDirectory?: string }> = {},
): TranscriptPathVerdict {
  const raw = candidate.trim()
  if (!raw) return { ok: false, reason: "transcript path is empty" }
  // A NUL byte truncates the path inside libuv, so `a\0/../../etc/passwd`
  // would resolve one way here and open another file on disk.
  if (raw.includes("\0")) return { ok: false, reason: "transcript path contains a NUL byte" }

  const home = options.homeDirectory ?? os.homedir()
  const workspace = options.workspaceDirectory && path.isAbsolute(options.workspaceDirectory)
    ? path.resolve(options.workspaceDirectory)
    : undefined

  // Relative paths would resolve against the MCP server's cwd, which is not a
  // meaningful base for a path chosen by a remote hook payload.
  if (!path.isAbsolute(raw)) return { ok: false, reason: "transcript path must be absolute" }

  const resolved = path.resolve(raw)

  const roots = [home, workspace].filter((root): root is string => Boolean(root)).map((root) => path.resolve(root))
  if (!roots.some((root) => contains(root, resolved))) {
    return { ok: false, reason: `transcript path is outside the allowed roots (${roots.join(", ")})` }
  }

  const segments = resolved.split(path.sep)
  const denied = segments.find((segment) => DENIED_SEGMENTS.has(segment))
  if (denied) return { ok: false, reason: `transcript path traverses '${denied}'` }
  if (DENIED_BASENAMES.has(path.basename(resolved))) {
    return { ok: false, reason: `'${path.basename(resolved)}' is not a transcript` }
  }

  return { ok: true, path: resolved }
}

/** True when `child` is `parent` itself or sits beneath it. */
function contains(parent: string, child: string) {
  if (child === parent) return true
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}
