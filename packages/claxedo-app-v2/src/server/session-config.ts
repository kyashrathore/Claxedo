import { responseError } from "./errors"
import type { SessionConfig } from "./harness-types"
import { sessionEndpoint } from "./session-context"
import { jsonInit, type Transport } from "./transport"
import type { ModelChoice, SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessIdentity } from "./wire/harness-selection"
import { sessionConfigFromWire } from "./wire/harness-state"

export type SessionConfigPatch = {
  readonly harness?: string
  readonly model?: ModelChoice
  readonly variant?: string
}

export async function readSessionConfig(transport: Transport, workspaces: Workspaces, ref: SessionRef): Promise<SessionConfig | undefined> {
  const response = await transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/config"))
  if (!response.ok) throw await responseError(response, "Session config")
  return sessionConfigFromWire(await response.json())
}

export async function writeSessionConfig(transport: Transport, workspaces: Workspaces, ref: SessionRef, patch: SessionConfigPatch): Promise<void> {
  const response = await transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/config"), jsonInit("PATCH", {
    ...(patch.harness ? { harness: harnessIdentity(patch.harness) } : {}),
    ...(patch.model ? { model: { providerID: patch.model.providerId, modelID: patch.model.modelId } } : {}),
    ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
  }))
  if (!response.ok) throw await responseError(response, "Session config")
}
