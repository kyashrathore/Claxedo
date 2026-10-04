import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { HARNESS_IDS, HARNESS_TABLE, type HarnessId } from "@claxedo/agent-runtime-contract"
import type { Server } from "@/server"
import type { HarnessType } from "../harness/profile"

export type HarnessAccountState = "present" | "missing" | "unknown" | "accountless"

const PROVIDER_CATALOG_HARNESSES: ReadonlySet<string> = new Set(["pi"])

function accountHarnessId(harness: HarnessType | undefined): HarnessId | undefined {
  if (harness?.kind !== "native") return undefined
  return HARNESS_IDS.find((id) => id === harness.harnessId)
}

function providerCatalogHarness(harness: HarnessType | undefined): string | undefined {
  return harness?.kind === "native" && PROVIDER_CATALOG_HARNESSES.has(harness.harnessId) ? harness.harnessId : undefined
}

export function createHarnessAccountState(server: Server, harness: Accessor<HarnessType | undefined>): Accessor<HarnessAccountState> {
  const catalog = useQuery(() => ({
    ...server.queries.providerCatalogs.catalog(providerCatalogHarness(harness()) ?? "pi"),
    enabled: providerCatalogHarness(harness()) !== undefined,
  }))
  const effective = useQuery(() => ({ ...server.queries.accounts.effective(), enabled: accountHarnessId(harness()) !== undefined }))
  return createMemo((): HarnessAccountState => {
    if (providerCatalogHarness(harness())) {
      return catalog.data ? (catalog.data.connected.length > 0 ? "present" : "missing") : "unknown"
    }
    const id = accountHarnessId(harness())
    if (!id) return "accountless"
    if (effective.data?.kind !== "listed") return "unknown"
    const providers: readonly string[] = HARNESS_TABLE[id].providerIds
    return effective.data.accounts.some((account) => providers.includes(account.providerId)) ? "present" : "missing"
  })
}
