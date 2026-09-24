import { createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer, type Account, type AppError, type EffectiveAccounts, type MachineLogin, type Server } from "@/server"
import { showToast } from "@/ui"
import { useAccountsText } from "./i18n"
import { harnesses, harnessRunnable, MACHINE_LOGIN_KEY, type AccountsSnapshot, type Harness, type LiveCheck } from "./model"

export type AccountActivity = { readonly kind: "selecting" | "checking" | "removing"; readonly key: string }

export type AccountsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: AccountsSnapshot }
  | { readonly kind: "failed"; readonly error: AppError }

export type Accounts = {
  readonly load: Accessor<AccountsLoad>
  readonly opened: Accessor<boolean>
  readonly scanning: Accessor<boolean>
  readonly activity: Accessor<AccountActivity | undefined>
  readonly liveChecks: Accessor<Readonly<Record<string, LiveCheck>>>
  readonly runnable: Accessor<boolean>
  readonly rescan: () => Promise<void>
  readonly select: (harness: Harness, key: string, ids: readonly string[]) => void
  readonly remove: (ids: readonly string[]) => Promise<void>
  readonly check: (id: string) => void
  readonly checkMachine: (harness: Harness) => void
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
    if (list.data && effective.data && logins.data) {
      const snapshot = { stored: list.data, effective: effectiveByProvider(effective.data), machineLogins: logins.data as readonly MachineLogin[], scannedAt: Math.max(...queries.map((query) => query.dataUpdatedAt)) }
      return { kind: "ready", snapshot }
    }
    const error = queries.map((query) => query.error).find((candidate) => candidate)
    return error ? { kind: "failed", error: toAppError(error) } : { kind: "loading" }
  })
  return { load, opened: () => load().kind !== "loading", fetching: () => queries.some((query) => query.isFetching) }
}

function useActivity() {
  const t = useAccountsText()
  const [activity, setActivity] = createSignal<AccountActivity>()
  const run = async (kind: AccountActivity["kind"], key: string, task: () => Promise<unknown>) => {
    setActivity({ kind, key })
    try {
      await task()
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
    } finally {
      setActivity(undefined)
    }
  }
  return { activity, run }
}

export function useAccounts(): Accounts {
  const server = useServer()
  const reads = useAccountReads(server)
  const { activity, run } = useActivity()
  const [rescanning, setRescanning] = createSignal(false)
  const [liveChecks, setLiveChecks] = createSignal<Readonly<Record<string, LiveCheck>>>({})
  const remember = (id: string, check: LiveCheck) => setLiveChecks((previous) => ({ ...previous, [id]: check }))
  const snapshot = () => {
    const load = reads.load()
    return load.kind === "ready" ? load.snapshot : undefined
  }
  return {
    load: reads.load,
    opened: reads.opened,
    scanning: () => rescanning() || reads.fetching(),
    activity,
    liveChecks,
    runnable: () => {
      const current = snapshot()
      return current !== undefined && harnesses.some((harness) => harnessRunnable(harness, current, liveChecks()))
    },
    rescan: () => run("checking", "", async () => {
      setRescanning(true)
      setLiveChecks({})
      await server.accounts.rescan().finally(() => setRescanning(false))
    }),
    select: (harness, key, ids) => void run("selecting", key, () => (key === MACHINE_LOGIN_KEY ? server.accounts.selectMachineLogin(harness.providerIds) : server.accounts.select(ids))),
    remove: (ids) => run("removing", ids[0] ?? "", () => server.accounts.remove(ids)),
    check: (id) =>
      void run("checking", id, async () => {
        const check = await server.accounts.check(id).catch((error: unknown) => ({ verdict: "unknown" as const, reason: toAppError(error).message }))
        remember(id, { at: Date.now(), ...check })
      }),
    checkMachine: (harness) => void run("checking", MACHINE_LOGIN_KEY, () => server.accounts.checkMachineLogin(harness.id)),
  }
}
