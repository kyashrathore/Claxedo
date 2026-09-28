import { HTTPException } from "hono/http-exception"
import type { AgentPermissionMode, AgentPermissionModeState, AgentSession, AutoLevel } from "@claxedo/agent-runtime-contract"
import {
  narrowerPermissionLevel,
  permissionCeilingAdmits,
  permissionModeLevel,
  widestPermissionModeUnder,
  type RuntimeDirectory,
} from "@claxedo/agent-sdk-runtime"
import type { AgentRuntime, HarnessTarget } from "../host/runtime"
import { errorBody } from "./error-body"
import {
  readSession,
  sessionConfigOf,
  sessionTarget,
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
  const state = await (await opts.runtime(c)).reads.permissionModes(sessionTarget(c, parent.id, directory))
  const parentLevel = inheritedPermissionLevel(state)
  if (!parentLevel) return declared
  return declared ? narrowerPermissionLevel(parentLevel, declared) : parentLevel
}

/** Resolve the persisted ceiling and the current parent restriction for mutations. */
export async function sessionPermissionCeiling(opts: Opts, c: Ctx, directory: RuntimeDirectory, session: AgentSession) {
  const config = await sessionConfigOf(opts, c, directory, session.id)
  const parent = session.parentID ? await readSession(opts, c, directory, session.parentID) : undefined
  if (session.parentID && !parent) throw new HTTPException(403, { message: "Parent session not found" })
  return effectivePermissionCeiling(opts, c, directory, parent ?? undefined, config.permissionCeiling)
}

export async function rejectPermissionOverride(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string, modeId: string | undefined) {
  if (!modeId) return undefined
  const session = await readSession(opts, c, directory, sessionId)
  if (!session) return c.json(errorBody("session_not_found", "Session not found"), 404)
  const ceiling = await sessionPermissionCeiling(opts, c, directory, session)
  if (!ceiling) return undefined
  return (await permissionModeUnderCeiling(c, await opts.runtime(c), sessionTarget(c, sessionId, directory), ceiling, modeId)).refusal
}

/**
 * The mode the new session starts in. A requested mode that widens the
 * ceiling is refused; with none requested the widest mode under the ceiling is
 * chosen, so a child never inherits a harness default above its parent.
 */
export async function permissionModeUnderCeiling(
  c: Ctx,
  runtime: AgentRuntime,
  target: HarnessTarget,
  ceiling: AutoLevel | undefined,
  requested: string | undefined,
): Promise<{ mode?: AgentPermissionMode; refusal?: Response }> {
  if (!requested && !ceiling) return {}
  const state = await runtime.reads.permissionModes(target)
  if (!state || state.unsupported) {
    if (ceiling) return { refusal: c.json(errorBody("permission_ceiling_unsupported", `This harness cannot enforce the ${ceiling} permission ceiling`), 403) }
    return { refusal: c.json(errorBody("permission_mode_unsupported", "This harness cannot be told about permission modes"), 400) }
  }
  const modes = state.modes
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
