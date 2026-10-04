import type { StartInput } from "../../contract"
import { codexProfilePaths } from "../../profiles/codex"
import { codexAccountIdentity } from "./account"

export function codexLaunchKey(input: StartInput, homeRoot: string): string {
  const { home } = codexProfilePaths({ homeRoot, credentials: input.credentials, projection: input.projection })
  return JSON.stringify([home, codexAccountIdentity(input), input.projection.pluginSelection ?? null, input.projection.generation])
}
