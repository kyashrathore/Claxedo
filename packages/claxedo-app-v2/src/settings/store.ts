import { createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer, type Account, type AppError, type EffectiveAccounts, type MachineLogin, type Server } from "@/server"
import { MACHINE_LOGIN_KEY, type AccountsSnapshot, type Harness, type LiveCheck } from "./accounts"

export type AccountActivity = { readonly kind: "selecting" | "checking" | "removing" | "connecting"; readonly key: string }

export type AccountFailure = { readonly key: string; readonly error: AppError }

export type AccountsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: AccountsSnapshot; readonly refreshError?: AppError }
  | { readonly kind: "failed"; readonly error: AppError }

export type Accounts = {
  readonly load: Accessor<AccountsLoad>
  readonly scanning: Accessor<boolean>
  readonly activity: Accessor<AccountActivity | undefined>
  readonly failure: Accessor<AccountFailure | undefined>
  readonly liveChecks: Accessor<Readonly<Record<string, LiveCheck>>>
  readonly rescan: () => void
  readonly select: (harness: Harness, key: string, ids: readonly string[]) => void
  readonly remove: (ids: readonly string[]) => void
  readonly check: (id: string) => void
  readonly checkMachine: (harness: Harness) => void
  readonly addKey: (harness: Harness, label: string, secret: string) => Promise<void>
}

function effectiveByProvider(effective: EffectiveAccounts): ReadonlyMap<string, Account> | undefined {
  return effective.kind === "listed" ? new Map(effective.accounts.map((account) => [account.providerId, account])) : undefined
}

function useAccountReads(server: Server) {
  const list = useQuery(() => server.queries.accounts.list())
  const effective = useQuery(() => server.queries.accounts.effective())
  const logins = useQuery(() => server.queries.accounts.machineLogins())
  const queries = [list, effective, logins] as const
  const load = createMemo((): AccountsLoad => {
    const error = queries.map((query) => query.error).find((candidate) => candidate)
    if (list.data && effective.data && logins.data) {
      const snapshot = { stored: list.data, effective: effectiveByProvider(effective.data), machineLogins: logins.data as readonly MachineLogin[], scannedAt: Math.max(...queries.map((query) => query.dataUpdatedAt)) }
      return error ? { kind: "ready", snapshot, refreshError: toAppError(error) } : { kind: "ready", snapshot }
    }
    return error ? { kind: "failed", error: toAppError(error) } : { kind: "loading" }
  })
  return {
    load,
    scanning: () => queries.some((query) => query.isFetching),
    rescan: () => queries.forEach((query) => void query.refetch()),
  }
}

export function useAccounts(): Accounts {
  const server = useServer()
  const reads = useAccountReads(server)
  const [activity, setActivity] = createSignal<AccountActivity>()
  const [failure, setFailure] = createSignal<AccountFailure>()
  const [liveChecks, setLiveChecks] = createSignal<Readonly<Record<string, LiveCheck>>>({})
  const run = (kind: AccountActivity["kind"], key: string, task: () => Promise<unknown>) => {
    setFailure(undefined)
    setActivity({ kind, key })
    return task()
      .catch((error: unknown) => setFailure({ key, error: toAppError(error) }))
      .finally(() => setActivity(undefined))
  }
  return {
    ...reads,
    activity,
    failure,
    liveChecks,
    select: (harness, key, ids) => void run("selecting", key, () => (key === MACHINE_LOGIN_KEY ? server.accounts.selectMachineLogin(harness.providerIds) : server.accounts.select(ids))),
    remove: (ids) => void run("removing", ids[0] ?? "", () => server.accounts.remove(ids)),
    check: (id) =>
      void run("checking", id, async () => {
        const check = await server.accounts.check(id)
        setLiveChecks((previous) => ({ ...previous, [id]: { at: Date.now(), ...check } }))
      }),
    checkMachine: (harness) => void run("checking", MACHINE_LOGIN_KEY, () => server.accounts.checkMachineLogin(harness.id)),
    addKey: async (harness, label, secret) => {
      setActivity({ kind: "connecting", key: harness.id })
      try {
        await server.accounts.addKey({ providerId: harness.connectProvider, label, secret })
      } finally {
        setActivity(undefined)
      }
    },
  }
}
