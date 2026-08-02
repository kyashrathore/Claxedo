import fs from "fs"
import os from "os"
import path from "path"
import { HTTPException } from "hono/http-exception"
import { normalizeHarnessIdentity, type SessionHarness } from "@claxedo/agent-sdk-runtime"
import { defaultHarness } from "../../agent-config"
import { dataDir, stateDir } from "../../platform/runtime/lib/paths"
import { normalize } from "../../session/harness"
import { contains } from "./git"

export type OpenCodeCompatRequestContext = {
  req: {
    query: (key: string) => string | undefined
    header: (key: string) => string | undefined
  }
}

export function workspaceInput(c: OpenCodeCompatRequestContext) {
  const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
  return {
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory,
  }
}

export function workspaceRoot(ws: { directory: string } | undefined | null, input: ReturnType<typeof workspaceInput>) {
  return ws?.directory ?? input.directory ?? process.cwd()
}

/** Symlink hops `canonical()` will follow by hand before it gives up. */
const LINK_HOPS = 32

async function real(target: string) {
  try {
    return await fs.promises.realpath(target)
  } catch {
    return undefined
  }
}

async function readLink(target: string) {
  try {
    return await fs.promises.readlink(target)
  } catch {
    return undefined
  }
}

/**
 * Canonicalize the part of `input` that exists on disk, then re-attach the part
 * that does not, lexically.
 *
 * The whole point is the non-existent case. `realpath` throws ENOENT for a file
 * that is merely *about* to be created, and the tempting repair — "on ENOENT,
 * fall back to the lexical path" — reintroduces the exact bug this closes:
 * `<root>/evil/passwd` where `evil` is a symlink to `/etc` ENOENTs the moment
 * `/etc/passwd` is missing, and the fallback then waves the whole path through
 * unresolved. So instead of abandoning resolution we shorten it: canonicalize
 * the deepest ancestor that DOES resolve and treat only the genuinely absent
 * tail as literal. A symlink cannot exist on a path component that does not
 * exist, so every symlink is inside the resolved prefix by construction.
 *
 * The `readLink` branch covers the one case `realpath` cannot: a DANGLING
 * symlink (`<root>/x` -> `/etc/nope`). It exists as a link, so it is not really
 * "the absent tail", but `realpath` still throws on it. Walking up would treat
 * `x` as a literal name and call it contained, so the link is followed by hand.
 * `LINK_HOPS` bounds that against a symlink cycle, where `realpath` throws
 * ELOOP and `readlink` happily walks the loop forever.
 *
 * Every other `realpath` failure (ENOTDIR mid-path, EACCES, ELOOP past the hop
 * cap) degrades to the lexical join safely: a component this process cannot
 * traverse is also a component it cannot open, so the caller's `fs` call fails
 * on the same wall rather than reading something it should not.
 */
async function canonical(input: string, hops = 0): Promise<string> {
  const target = path.resolve(input)
  const resolved = await real(target)
  if (resolved !== undefined) return path.resolve(resolved)
  const parent = path.dirname(target)
  if (parent === target) return target
  const link = hops < LINK_HOPS ? await readLink(target) : undefined
  if (link !== undefined) return await canonical(path.resolve(parent, link), hops + 1)
  return path.join(await canonical(parent, hops), path.basename(target))
}

/**
 * Resolve a caller-named `?path=` against the workspace root, and REFUSE
 * anything that lands outside it.
 *
 * Before containment this was `path.resolve(root, file)` with no check, so
 * `?path=../../../../etc/passwd` (and its absolute twin `?path=/etc/passwd`)
 * resolved cleanly and was handed straight to `fs.readdir`/`fs.readFile` in
 * opencode-compat-file-browser.ts. Self-host only — this router is not mounted
 * on the hosted Cloudflare Worker — but a signed self-host box
 * (CLAXEDO_EMBEDDED_AUTH=1) is remotely reachable by design, so "local" is not
 * "unreachable".
 *
 * Absolute input stays supported on purpose: the directory listing returns an
 * `absolute` field per entry and the client round-trips it back. Resolving
 * first and containing second keeps that working while rejecting an absolute
 * path that points elsewhere.
 *
 * `contains()` (opencode-compat-git.ts, the same route family's single
 * definition) compares with a trailing separator, so a sibling root like
 * `/srv/project-evil` is not accepted as a child of `/srv/project`.
 *
 * Reject, never clamp: silently rewriting an escaping path to `root` would
 * answer a traversal probe with a plausible 200 and hide the attempt.
 *
 * Containment is checked on the CANONICAL forms of both sides, so a symlink
 * inside the root that points outward is refused — a string compare cannot see
 * one. Both sides are canonicalized because the root legitimately is a symlink
 * on macOS (`os.tmpdir()` sits under `/var` -> `/private/var`), and comparing a
 * raw root against a resolved candidate would reject every real workspace.
 *
 * What is returned is the LEXICAL path, not the canonical one. Callers rebuild
 * client-visible paths with `path.relative(root, …)`, which would produce
 * `../../private/var/…` nonsense against a canonicalized return. It is also why
 * the `..`-after-symlink discrepancy (the kernel resolves `link/..` against the
 * link's target, `path.resolve` against its parent) is not exploitable here:
 * the value handed back is the already-collapsed string the caller then opens,
 * so there is no un-collapsed `..` left for the kernel to interpret differently.
 *
 * Async because `canonical()` can walk up an arbitrarily deep path and follow up
 * to `LINK_HOPS` links, so the sync form blocked the event loop for a whole
 * chain of `realpath` syscalls on every file-browser request — on a server that
 * also holds long-lived SSE streams open. Both call sites
 * (`directoryEntriesBody`, `fileContentBody` in
 * opencode-compat-file-browser.ts) were already `async`. The two
 * canonicalizations are independent, so they run concurrently.
 *
 * Residual, honestly: this is TOCTOU-bounded, not TOCTOU-free. Nothing stops a
 * component from being swapped for an escaping symlink between this check and
 * the caller's `fs` call.
 *
 * Deliberately NOT copied here: the dev/ino parent pinning in
 * `repositoryMoveTarget` (documents/local-backend.ts). That idiom re-verifies
 * the parent's identity *around* its own write, so it can still refuse after a
 * swap. This helper hands back a STRING that the caller opens later, so the
 * same check would re-verify a parent and then return into the identical race —
 * more syscalls, no narrower window. Closing it for real means reading from a
 * pinned handle (`O_NOFOLLOW`, as `readContained()` in
 * documents/session-hydration.ts does) rather than hardening the path helper;
 * `fs.readdir` has no such form at all. The window is narrow and both callers
 * here only read.
 */
export async function workspacePath(root: string, input?: string) {
  const file = input?.trim()
  if (!file) return root
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file)
  const [base, target] = await Promise.all([canonical(root), canonical(resolved)])
  if (!contains(base, target)) {
    // Matches `errorBody()` in routes/http.ts. Thrown rather than returned
    // because `workspacePath` is a helper shared by handlers that have no
    // error channel of their own; Hono turns an HTTPException into exactly
    // this response, and both entrypoints' `onError` pass it through unreported
    // (it is a deliberate 400, not error-tracker material).
    throw new HTTPException(400, {
      res: Response.json(
        {
          error: {
            code: "opencode_path_outside_workspace",
            message: "path resolves outside the workspace root",
          },
        },
        { status: 400 },
      ),
    })
  }
  return resolved
}

export function runner(c: OpenCodeCompatRequestContext, fallback = defaultHarness()) {
  const input = c.req.query("harness") || c.req.query("runner") || fallback.id
  const identity = normalizeHarnessIdentity(input)
  if (!identity) return fallback
  if (identity.id === "opencode") return { id: "opencode", access: "native" } satisfies SessionHarness
  return normalize({
    id: identity.id,
    access: identity.access,
    ...(c.req.query("binary") ? { connection: { kind: "process" as const, binary: c.req.query("binary")! } } : {}),
  })
}

export function bootPath(directory?: string) {
  const dir = directory?.trim() ?? ""
  return {
    home: os.homedir(),
    state: stateDir(),
    config: dataDir(),
    worktree: dir,
    directory: dir,
  }
}

/** Read optional harness query param; accepts legacy `?runner=` while callers migrate. */
export function queryHarnessId(c: OpenCodeCompatRequestContext): string | undefined {
  const runner = c.req.query("harness") || c.req.query("runner")
  const identity = runner ? normalizeHarnessIdentity(runner) : undefined
  if (identity) return identity.id
  return undefined
}

export function requestHarnessId(c: OpenCodeCompatRequestContext): string | undefined {
  return queryHarnessId(c)
}
