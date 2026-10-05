import { isProductToolKind, type ProductEvent, type ProductEventProperties, type ProductToolKind } from "@claxedo/account-contract/product-events"
import { canonicalToolName } from "@claxedo/agent-runtime-contract"
import { harnessSelectionOf } from "../lib/harness-selection"
import type { HostedAccount } from "./account"
import { toAppError } from "./errors"
import type { PlacementKind } from "./types"

export type ProductTelemetry = { readonly record: (event: ProductEvent) => void }

export type ProductErrorSurface = ProductEventProperties<"ui_error_shown">["surface"]

export function createProductTelemetry(account: HostedAccount | undefined): ProductTelemetry {
  return {
    record: (event) => {
      if (!account) return
      account.run("telemetry.track", event).catch((error: unknown) => {
        console.warn("A product event could not be recorded", { event: event.event, error: toAppError(error) })
      })
    },
  }
}

export function productHarness(harness: string | undefined): ProductEventProperties<"session_started">["harness"] {
  if (!harness) return "default"
  const selection = harnessSelectionOf(harness)
  return selection.kind === "native" ? selection.harnessId : "connection"
}

export function productWhere(kind: PlacementKind | undefined): "machine" | "cloud" {
  return kind === "cloud" ? "cloud" : "machine"
}

export function productToolKind(permission: string): ProductToolKind {
  const name = canonicalToolName(permission)
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return "mcp"
  return isProductToolKind(name) ? name : "other"
}
