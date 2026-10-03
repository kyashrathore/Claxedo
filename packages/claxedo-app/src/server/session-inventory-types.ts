import type { SessionActivityFilter } from "@claxedo/agent-runtime-contract"
import type { SessionPage } from "./types"

export type SessionInventoryInput = {
  readonly activity?: SessionActivityFilter
  readonly ownership?: "all" | "shared"
  readonly settled: "active"
  readonly limit: number
  readonly after?: string
}

export type SessionInventoryPage = SessionPage & { readonly totalKnown: number }
