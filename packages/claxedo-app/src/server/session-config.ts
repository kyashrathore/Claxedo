import { responseError } from "./errors"
import { sessionEndpoint } from "./session-context"
import { jsonInit, type Transport } from "./transport"
import type { ModelChoice, SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessIdentity } from "./wire/harness-selection"

export type SessionConfigPatch = {
  readonly harness?: string
  readonly model?: ModelChoice
  readonly variant?: string | null
}

export async function writeSessionConfig(transport: Transport, workspaces: Workspaces, ref: SessionLocation, patch: SessionConfigPatch): Promise<void> {
  const response = await transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/config"), jsonInit("PATCH", {
    ...(patch.harness ? { harness: harnessIdentity(patch.harness) } : {}),
    ...(patch.model ? { model: { providerID: patch.model.providerId, modelID: patch.model.modelId } } : {}),
    ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
  }))
  if (!response.ok) throw await responseError(response, "Session config")
}
