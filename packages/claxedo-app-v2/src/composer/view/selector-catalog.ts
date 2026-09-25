import { createEffect, type Accessor } from "solid-js"
import type { Server } from "@/server"
import type { HarnessScopeInput } from "../harness/controller"
import { catalogHarnessId, type HarnessType } from "../harness/profile"
import { createProviderCatalog, createProviderCatalogReadiness, createProviderCatalogRows } from "../harness/provider-catalog"

export function createSelectorCatalog(input: {
  server: Server
  harness: Accessor<HarnessType | undefined>
  sessionId: Accessor<HarnessScopeInput["sessionId"]>
}) {
  const providers = createProviderCatalog({ server: input.server, harness: () => catalogHarnessId(input.harness()) ?? "" })
  const draftPane = () => !input.sessionId() || input.sessionId() === "new"
  createEffect(() => {
    if (draftPane() && catalogHarnessId(input.harness())) providers.request()
  })
  const rows = createProviderCatalogRows(providers)
  const readiness = createProviderCatalogReadiness({ providers, harness: input.harness })
  return { providers, rows, ready: readiness.ready, unread: readiness.unread, variants: readiness.variants }
}

export type SelectorCatalog = ReturnType<typeof createSelectorCatalog>
