import { createHash } from "node:crypto"
import type { StartInput } from "../../contract"
import { codexProfilePaths } from "../../profiles/codex"
import { codexAccountIdentity } from "./account"
import type { CodexTransportOptions } from "./entry"

export function codexLaunchKey(input: StartInput, options: Pick<CodexTransportOptions, "binary" | "homeRoot">): string {
  const { home } = codexProfilePaths({ homeRoot: options.homeRoot, credentials: input.credentials, projection: input.projection })
  const identity = [options.binary, input.credentials.accountOwner, codexAccountIdentity(input), home, input.projection.pluginSelection ?? null, input.projection.generation]
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex")
}
