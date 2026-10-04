import type { RuntimeSnapshot } from "@claxedo/workspace-runtime/config"

const IMAGE_SMOKE_ACCOUNT_OWNER = "image-smoke-owner"
export const IMAGE_SMOKE_PLACEHOLDER = "image-proof-placeholder"

/**
 * Mirrors the control plane's push to a cloud VM, which carries brokered
 * account rows and never direct ones. The smoke's session has no relay actor,
 * so it spends the machine owner's accounts.
 */
export function imageSmokeRuntimeSnapshot(providerBaseUrl: string): RuntimeSnapshot {
  return {
    version: 4,
    mcp: {},
    connections: [],
    commands: [],
    defaultHarness: { kind: "native", harnessId: "opencode" },
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
