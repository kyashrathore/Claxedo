import { useAuth } from "@/auth"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { marketplaceDictionary, type MarketplaceKey } from "../i18n"

type ScopeKeys = { readonly account: MarketplaceKey; readonly machine: MarketplaceKey; readonly here: MarketplaceKey }

const SCOPE = {
  facts: { account: "marketplace.facts.everyProject", machine: "marketplace.facts.everyProjectOn", here: "marketplace.facts.everyProjectHere" },
  install: { account: "marketplace.install.everyProject", machine: "marketplace.install.everyProjectOn", here: "marketplace.install.everyProjectHere" },
} as const satisfies Record<string, ScopeKeys>

export function useProjectScopeText(): (place: keyof typeof SCOPE) => string {
  const t = useTranslator(marketplaceDictionary)
  const auth = useAuth()
  const server = useServer()
  return (place) => {
    const keys = SCOPE[place]
    if (auth.state().kind === "signedIn") return t(keys.account)
    const machine = server.capabilities()?.servingMachine?.name
    return machine ? t(keys.machine, { machine }) : t(keys.here)
  }
}
