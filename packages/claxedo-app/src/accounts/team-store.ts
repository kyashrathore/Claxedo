import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer, type AccountSources, type AppError } from "@/server"
import { createKeyActions, type KeyActivity } from "./key-actions"
import type { LiveCheck } from "./model"

export type TeamAccountsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly sources: AccountSources }
  | { readonly kind: "failed"; readonly error: AppError }

export type TeamActivity = KeyActivity<"saving" | "checking" | "removing">

export type TeamAccountsStore = {
  readonly load: Accessor<TeamAccountsLoad>
  readonly activity: Accessor<TeamActivity | undefined>
  readonly liveChecks: Accessor<Readonly<Record<string, LiveCheck>>>
  readonly save: (providerId: string, secret: string, label: string) => Promise<boolean>
  readonly check: (id: string) => void
  readonly remove: (id: string) => void
}

export function useTeamAccounts(): TeamAccountsStore {
  const server = useServer()
  const query = useQuery(() => server.queries.accounts.sources())
  const load = createMemo((): TeamAccountsLoad => {
    if (query.data) return { kind: "ready", sources: query.data }
    return query.error ? { kind: "failed", error: toAppError(query.error) } : { kind: "loading" }
  })
  const { activity, liveChecks, run, verify } = createKeyActions<TeamActivity["kind"]>(server.accounts.check)
  return {
    load,
    activity,
    liveChecks,
    save: (providerId, secret, label) => run("saving", providerId, async () => verify((await server.accounts.saveOrgAccount(providerId, secret, label)).id)),
    check: (id) => void run("checking", id, () => verify(id)),
    remove: (id) => void run("removing", id, () => server.accounts.remove([id])),
  }
}
