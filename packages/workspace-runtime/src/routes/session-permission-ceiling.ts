import { HTTPException } from "hono/http-exception"
import type { AgentSession, RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import {
  narrowerPermissionLevel,
  permissionCeilingAdmits,
  permissionModeLevel,
  widestPermissionModeUnder,
  type AgentPermissionMode,
  type AgentPermissionModeState,
  type AutoLevel,
} from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { errorBody } from "./error-body"
import {
  readRuntimeSession,
  requireExecutionBinding,
  type SessionRouteContext as Ctx,
  type SessionRouteOptions as Opts,
} from "./session-route-options"

/**
 * The restriction a parent hands down: `ask` when its harness has a mode
 * surface but reports no current mode, and nothing at all when the harness has
 * no mode surface. A harness with no surface enforces no restriction on the
 * parent either, so reading it as the floor would invent a ceiling the parent
 * never ran under and refuse every child on that harness.
 */
function inheritedPermissionLevel(state: AgentPermissionModeState | undefined): AutoLevel | undefined {
  if (!state || state.unsupported) return undefined
  return permissionModeLevel(state.modes.find((mode) => mode.id === state.currentModeId))
}

/**
 * The level a new session may not exceed: the narrower of the restriction the
 * parent hands down and the ceiling the caller declared.
 */
export async function effectivePermissionCeiling(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  parent: AgentSession | undefined,
  declared: AutoLevel | undefined,
): Promise<AutoLevel | undefined> {
  if (!parent) return declared
  const adapter = await opts.resolveAdapter(c, { sessionId: parent.id, directory })
  const state = adapter.listPermissionModes
    ? await adapter.listPermissionModes(await requireExecutionBinding(opts, c, directory, parent.id, adapter))
    : undefined
  const parentLevel = inheritedPermissionLevel(state)
  if (!parentLevel) return declared
  return declared ? narrowerPermissionLevel(parentLevel, declared) : parentLevel
}

/** Resolve the persisted ceiling and the current parent restriction for mutations. */
export async function sessionPermissionCeiling(opts: Opts, c: Ctx, directory: RuntimeDirectory, session: AgentSession, adapter: AgentHarnessAdapter) {
  const config = opts.getSessionConfig
    ? await opts.getSessionConfig(c, directory, session.id, adapter)
    : await adapter.getSessionConfig(await requireExecutionBinding(opts, c, directory, session.id, adapter))
  const parent = session.parentID ? await readRuntimeSession(opts, c, directory, session.parentID) : undefined
  if (session.parentID && !parent) throw new HTTPException(403, { message: "Parent session not found" })
  return effectivePermissionCeiling(opts, c, directory, parent ?? undefined, config.permissionCeiling)
}

export async function rejectPermissionOverride(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string, adapter: AgentHarnessAdapter, modeId: string | undefined) {
  if (!modeId) return undefined
  const session = await readRuntimeSession(opts, c, directory, sessionId, adapter)
  if (!session) return c.json(errorBody("session_not_found", "Session not found"), 404)
  const ceiling = await sessionPermissionCeiling(opts, c, directory, session, adapter)
  if (!ceiling) return undefined
  return (await permissionModeUnderCeiling(c, adapter, directory, ceiling, modeId)).refusal
}

/**
 * The mode the new session starts in. A requested mode that widens the
 * ceiling is refused; with none requested the widest mode under the ceiling is
 * chosen, so a child never inherits a harness default above its parent.
 */
export async function permissionModeUnderCeiling(
  c: Ctx,
  adapter: AgentHarnessAdapter,
  directory: RuntimeDirectory,
  ceiling: AutoLevel | undefined,
  requested: string | undefined,
): Promise<{ mode?: AgentPermissionMode; refusal?: Response }> {
  if (!requested && !ceiling) return {}
  if (!adapter.listDraftPermissionModes || !adapter.setPermissionMode) {
    if (ceiling) return { refusal: c.json(errorBody("permission_ceiling_unsupported", `This harness cannot enforce the ${ceiling} permission ceiling`), 403) }
    return { refusal: c.json(errorBody("permission_mode_unsupported", "This harness cannot be told about permission modes"), 400) }
  }
  const modes = (await adapter.listDraftPermissionModes(directory)).modes
  if (requested) {
    const mode = modes.find((candidate) => candidate.id === requested)
    if (!mode) return { refusal: c.json(errorBody("unknown_permission_mode", `Unknown permission mode "${requested}"`), 400) }
    const level = permissionModeLevel(mode)
    if (ceiling && !permissionCeilingAdmits(ceiling, level)) {
      return {
        refusal: c.json({
          error: {
            code: "permission_ceiling_exceeded",
            message: `Permission mode "${mode.id}" (${level}) widens the ${ceiling} ceiling`,
            ceiling,
            requested: { modeId: mode.id, level },
          },
        }, 403),
      }
    }
    return { mode }
  }
  const mode = widestPermissionModeUnder(modes, ceiling!)
  return mode ? { mode } : {
    refusal: c.json(errorBody("permission_ceiling_unsupported", `This harness offers no permission mode within the ${ceiling} ceiling`), 403),
  }
}
