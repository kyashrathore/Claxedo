import type { RuntimeSnapshot } from "@claxedo/workspace-runtime/config"

const IMAGE_SMOKE_ACCOUNT_OWNER = "image-smoke-owner"
export const IMAGE_SMOKE_PLACEHOLDER = "image-proof-placeholder"

/**
 * The config push the image smoke applies before its native turn. The harness
 * owns Pi's models.json and rewrites it from every config apply, so the provider
 * reaches Pi the way a control-plane push does. Groq is the Pi provider whose
 * built-in wire protocol is chat completions.
 *
 * The smoke's session has no relay actor, so it spends the machine owner's
 * accounts.
 */
export function imageSmokeRuntimeSnapshot(providerBaseUrl: string): RuntimeSnapshot {
  return {
    version: 4,
    mcp: {},
    connections: [],
    commands: [],
    defaultHarness: { kind: "native", harnessId: "pi" },
    auth: {
      machineOwnerUserId: IMAGE_SMOKE_ACCOUNT_OWNER,
      accounts: {
        [IMAGE_SMOKE_ACCOUNT_OWNER]: {
          groq: { baseUrl: providerBaseUrl, apiPath: "/openai/v1", placeholder: IMAGE_SMOKE_PLACEHOLDER, authMode: "bearer" },
        },
      },
    },
  }
}
