import type { AcpScript } from "./acp/script"

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
