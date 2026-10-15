import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer, type AppError, type SandboxKeys } from "@/server"
import { createKeyActions, type KeyActivity } from "./key-actions"
import type { LiveCheck } from "./model"

export type SandboxListing = Extract<SandboxKeys, { readonly kind: "listed" }>

export type SandboxKeysLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly listing: SandboxListing }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly error: AppError }

export type SandboxActivity = KeyActivity<"saving" | "checking" | "removing" | "choosing">

export type SandboxKeysStore = {
  readonly load: Accessor<SandboxKeysLoad>
  readonly activity: Accessor<SandboxActivity | undefined>
  readonly liveChecks: Accessor<Readonly<Record<string, LiveCheck>>>
  readonly save: (driver: string, fields: Readonly<Record<string, string>>) => Promise<boolean>
  readonly check: (id: string) => void
  readonly remove: (id: string) => void
  readonly choose: (driver: string | null) => void
}

export function useSandboxKeys(): SandboxKeysStore {
  const server = useServer()
  const query = useQuery(() => server.queries.accounts.sandbox())
  const load = createMemo((): SandboxKeysLoad => {
    if (query.data) return query.data.kind === "listed" ? { kind: "ready", listing: query.data } : { kind: "unsupported" }
    return query.error ? { kind: "failed", error: toAppError(query.error) } : { kind: "loading" }
  })
  const { activity, liveChecks, run, verify } = createKeyActions<SandboxActivity["kind"]>()
  return {
    load,
    activity,
    liveChecks,
    save: (driver, fields) => run("saving", driver, async () => verify((await server.accounts.saveSandboxKey(driver, fields)).id)),
    check: (id) => void run("checking", id, () => verify(id)),
    remove: (id) => void run("removing", id, () => server.accounts.remove([id])),
    choose: (driver) => void run("choosing", driver ?? "", () => server.accounts.chooseSandboxDriver(driver)),
  }
}
