import type { NativeSdkHarnessId } from "./harnesses"
import { isRecord } from "@claxedo/helpers/guards"

/**
 * The account a turn ran on: a stored credential the broker spent, named by
 * its non-secret metadata, or the harness's own login on this machine when no
 * credential was bound for it.
 */
export type TurnAccount =
  | { readonly kind: "stored"; readonly harnessId: NativeSdkHarnessId; readonly credentialId: string; readonly providerId: string; readonly label?: string }
  | { readonly kind: "machine"; readonly harnessId: NativeSdkHarnessId }

const HARNESS_IDS = ["claude", "codex", "cursor", "pi"] as const satisfies readonly NativeSdkHarnessId[]

export function turnAccount(input: unknown): TurnAccount | undefined {
  if (!isRecord(input)) return undefined
  const harnessId = HARNESS_IDS.find((id) => id === input.harnessId)
  if (!harnessId) return undefined
  if (input.kind === "machine") return { kind: "machine", harnessId }
  if (input.kind !== "stored" || typeof input.credentialId !== "string" || typeof input.providerId !== "string") return undefined
  const label = typeof input.label === "string" && input.label ? { label: input.label } : {}
  return { kind: "stored", harnessId, credentialId: input.credentialId, providerId: input.providerId, ...label }
}
