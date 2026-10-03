import { HARNESS_TABLE, isHarnessId, PI_LAUNCH_PROVIDERS } from "@claxedo/agent-runtime-contract"
import { credentialReach } from "../reach"
import { VENDOR_PROVIDER_NAMES } from "../vendor-providers"

export type ProviderAuthPrompt =
  | {
      type: "text"
      key: string
      message: string
      placeholder?: string
      when?: { key: string; op: "eq" | "neq"; value: string }
    }
  | {
      type: "select"
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
      when?: { key: string; op: "eq" | "neq"; value: string }
    }

export type ProviderAuthMethod = {
  type: "oauth" | "api" | "token"
  label: string
  /** For `token`: the terminal command that prints the token to paste. */
  command?: string
  prompts?: ProviderAuthPrompt[]
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>

/**
 * Where the accounts a method connects are spent. `cloud` serves only the
 * methods whose stored credential a cloud sandbox can be delivered, for a host
 * that runs every session in one.
 */
export type ProviderAuthReach = "any" | "cloud"

function allProviderAuthMethods(): ProviderAuthMethods {
  return {
    ...Object.fromEntries(Object.keys(VENDOR_PROVIDER_NAMES).map((id) => [id, [{ type: "api" as const, label: "API Key" }]])),
    anthropic: [
      { type: "token", label: "Claude subscription token", command: "claude setup-token" },
      { type: "api", label: "API Key" },
    ],
    "claude-sdk": [
      { type: "token", label: "Claude subscription token", command: "claude setup-token" },
      { type: "api", label: "API Key" },
    ],
    "codex-app-server": [
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ],
    "cursor-sdk": [{ type: "api", label: "API Key" }],
    openai: [
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ],
  }
}

/** A pasted subscription token is stored as the plan login it is, like an OAuth sign-in. */
function reachesCloud(providerId: string, method: ProviderAuthMethod) {
  return credentialReach({ provider_id: providerId, kind: method.type === "api" ? "api_key" : "oauth_token" }).cloud
}

export function providerAuthMethods(reach: ProviderAuthReach = "any"): ProviderAuthMethods {
  const methods = allProviderAuthMethods()
  if (reach === "any") return methods
  return Object.fromEntries(Object.entries(methods).flatMap(([providerId, listed]) => {
    const served = listed.filter((method) => reachesCloud(providerId, method))
    return served.length ? [[providerId, served]] : []
  }))
}

/**
 * The sign-in methods a harness's accounts are connected with. A catalog
 * harness lists every provider it can launch on; Pi's ChatGPT plan is the
 * Codex login alone, and its OpenAI provider a key alone, because each is a
 * different endpoint. A native harness has the one provider its login is
 * stored against. OpenCode also offers a key for every provider the caller's
 * organization declared. Undefined for a harness with no methods.
 */
export function providerAuthMethodsForHarness(
  harness: string,
  input: { reach?: ProviderAuthReach; customProviderIds?: readonly string[] } = {},
): ProviderAuthMethods | undefined {
  const methods = providerAuthMethods(input.reach)
  if (harness === "opencode") {
    const key: ProviderAuthMethod[] = [{ type: "api", label: "API Key" }]
    return { ...Object.fromEntries((input.customProviderIds ?? []).map((id) => [id, key])), ...methods }
  }
  if (harness === "pi") {
    return Object.fromEntries(PI_LAUNCH_PROVIDERS.flatMap((id) => {
      const served = id === "openai-codex" ? methods["codex-app-server"]?.filter((method) => method.type === "oauth")
        : id === "openai" ? methods.openai?.filter((method) => method.type === "api")
          : methods[id]
      return served?.length ? [[id, served]] : []
    }))
  }
  if (!isHarnessId(harness)) return undefined
  const provider = HARNESS_TABLE[harness].connectProvider
  const served = methods[provider]
  return served ? { [provider]: served } : undefined
}
