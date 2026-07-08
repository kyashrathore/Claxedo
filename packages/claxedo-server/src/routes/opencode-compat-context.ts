import os from "os"
import path from "path"
import { normalizeHarnessIdentity, type SessionHarness } from "@claxedo/agent-sdk-runtime"
import { defaultHarness } from "../agent-config"
import { dataDir, stateDir } from "../paths"
import { normalize } from "../session-harness"

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

export function workspacePath(root: string, input?: string) {
  const file = input?.trim()
  if (!file) return root
  return path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file)
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
