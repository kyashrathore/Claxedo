import type { SandboxDriver } from "@claxedo/sandbox-manager"
import type { AcpScript } from "./acp/script"

export type CloudFault = "config-push-refused" | "broker-secret-withheld" | "acp-answer-withheld"
  | "commands-withheld" | "command-delete-withheld" | "plugin-mcp-withheld" | "default-harness-withheld"

/**
 * The hosted stack's sandbox worker reads this. With `gateway-secret-withheld`
 * the plugin gateway credentials never reach the broker, so the placeholder a
 * sandbox presents goes upstream unsubstituted and the gateway refuses it;
 * with `broker-secret-withheld` no brokered secret reaches it at all, so a
 * provider request leaves the sandbox bare and the model refuses it.
 */
export type HostedFault = "gateway-secret-withheld" | "broker-secret-withheld"

export function hostedFaultSecrets<T extends { name: string }>(secrets: T[], fault: string | undefined): T[] {
  if (fault === "broker-secret-withheld") return []
  if (fault !== "gateway-secret-withheld") return secrets
  return secrets.filter((secret) => !secret.name.startsWith("CLAXEDO_MCP_"))
}

export function cloudAcpScript(script: AcpScript, fault: string | undefined): AcpScript {
  if (fault !== "acp-answer-withheld") return script
  return { ...script, steps: script.steps.filter((step) => step.kind !== "text") }
}

export function installCloudConfigFault(fault: string | undefined) {
  if (!["config-push-refused", "commands-withheld", "command-delete-withheld", "plugin-mcp-withheld", "default-harness-withheld"].some((name) => name === fault)) return
  let commandDelivered = false
  let deletionWithheld = false
  const original = globalThis.fetch
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    if (new URL(url).pathname === "/api/wr/config" && method === "POST") {
      if (fault === "config-push-refused") return Promise.resolve(new Response("cloud config push refused by test fault", { status: 503 }))
      if (typeof init?.body !== "string") throw new Error("Cloud snapshot fault requires a JSON body")
      const snapshot = JSON.parse(init.body) as Record<string, unknown>
      if (fault === "command-delete-withheld" && Array.isArray(snapshot.commands)) {
        if (snapshot.commands.length) commandDelivered = true
        else if (commandDelivered && !deletionWithheld) {
          deletionWithheld = true
          return Promise.resolve(new Response(null, { status: 204 }))
        }
      }
      if (fault === "commands-withheld") snapshot.commands = []
      if (fault === "plugin-mcp-withheld") snapshot.mcp = {}
      if (fault === "default-harness-withheld") delete snapshot.defaultHarness
      return original(input, { ...init, body: JSON.stringify(snapshot) })
    }
    return original(input, init)
  }, { preconnect: original.preconnect })
}

export function cloudFaultDriver<T extends SandboxDriver>(driver: T, fault: string | undefined): T {
  if (fault !== "broker-secret-withheld") return driver
  return {
    ...driver,
    ensureHost: (input) => driver.ensureHost({ ...input, secrets: [] }),
  }
}
