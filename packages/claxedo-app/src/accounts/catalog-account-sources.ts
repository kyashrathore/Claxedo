import type { AccountSource } from "@claxedo/account-contract/vocabulary"
import { useQuery } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { piProviderAccountIds, toAppError, useServer } from "@/server"
import { showToast } from "@/ui"
import { useAccountsText } from "./i18n"

export function createCatalogAccountSources(harness: () => string, refreshCatalog: () => Promise<unknown>) {
  const server = useServer()
  const t = useAccountsText()
  const enabled = () => harness() === "pi" && server.capabilities() !== undefined
  const query = useQuery(() => ({ ...server.queries.accounts.sources(), enabled: enabled() }))
  const [writing, setWriting] = createSignal<string>()
  const read = () => (enabled() ? query.data : undefined)
  const source = (providerId: string): AccountSource => {
    const ids = piProviderAccountIds(providerId)
    return ids.length > 0 && ids.every((id) => read()?.sources.get(id) === "org") ? "org" : "own"
  }
  const orgHeld = (providerId: string) => read()?.org.some((row) => piProviderAccountIds(providerId).includes(row.providerId)) === true
  const choose = async (providerId: string, chosen: AccountSource) => {
    setWriting(providerId)
    try {
      await server.accounts.setSource(piProviderAccountIds(providerId), chosen)
      await refreshCatalog()
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
    } finally {
      setWriting(undefined)
    }
  }
  return {
    error: () => (enabled() && query.error ? toAppError(query.error).message : undefined),
    source,
    orgHeld,
    offered: (providerId: string) => read() !== undefined && (orgHeld(providerId) || source(providerId) === "org"),
    writing,
    choose: (providerId: string, chosen: AccountSource) => void choose(providerId, chosen),
  }
}

export type CatalogAccountSourceChoices = ReturnType<typeof createCatalogAccountSources>
