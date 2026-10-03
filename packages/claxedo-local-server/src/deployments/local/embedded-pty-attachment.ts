import fs from "node:fs/promises"
import path from "node:path"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { SessionAccessPolicy } from "@claxedo/session-core"
import {
  authorizePtyAttach,
  createAuthorizedPtyConnection,
  Pty,
  ptyAccessRefusalResponse,
  ptyStreamAccess,
  PTY_NOT_FOUND_REFUSAL,
  type AuthorizedPtyConnection,
} from "@claxedo/workspace-runtime"
import type { EmbeddedRelayHostIdentity } from "@claxedo/session-core/relay-host"

const log = Log.create({ service: "embedded-workspace-runtime" })

async function realPath(input: string) {
  return await fs.realpath(input).catch(() => path.resolve(input))
}

async function ownsPath(ws: Workspace, cwd: string) {
  const [root, current] = await Promise.all([
    realPath(ws.directory),
    realPath(cwd),
  ])
  return current === root || current.startsWith(root + path.sep)
}

export type EmbeddedWorkspacePtyAttachment =
  | { ok: true; connection: AuthorizedPtyConnection }
  | { ok: false; response: Response }

export type EmbeddedPtyAttachInput = {
  workspace: Workspace
  ptyId: string
  identity?: EmbeddedRelayHostIdentity
  authorization?: string
  method: string
  path: string
  cursor?: number
}

export async function attachEmbeddedPty(input: EmbeddedPtyAttachInput, policy: SessionAccessPolicy): Promise<EmbeddedWorkspacePtyAttachment> {
  const info = Pty.get(input.ptyId)
  if (!info || !await ownsPath(input.workspace, info.cwd)) {
    log.warn("terminal attach refused", {
      ptyId: input.ptyId,
      workspaceId: input.workspace.id,
      reason: info ? "outside the workspace" : "no such PTY in this process",
    })
    return { ok: false, response: ptyAccessRefusalResponse(PTY_NOT_FOUND_REFUSAL) }
  }
  const access = ptyStreamAccess({
    ...(input.identity ? { identity: input.identity } : {}),
    ...(input.authorization ? { authorization: input.authorization } : {}),
    method: input.method,
    path: input.path,
  })
  const admission = await authorizePtyAttach({ policy, access, info })
  if (!admission.allowed) return { ok: false, response: ptyAccessRefusalResponse(admission) }
  return {
    ok: true,
    connection: createAuthorizedPtyConnection({
      ptyId: input.ptyId,
      policy,
      access,
      admission,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
  }
}

