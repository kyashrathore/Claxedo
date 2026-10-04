import { createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer, type Account, type AppError, type EffectiveAccounts, type MachineLogin, type Server } from "@/server"
import { showToast } from "@/ui"
import { useAccountsText } from "./i18n"
import { harnesses, harnessRunnable, MACHINE_LOGIN_KEY, ORG_ACCOUNT_KEY, type AccountsSnapshot, type Harness, type LiveCheck } from "./model"

export type AccountActivity = { readonly kind: "selecting" | "checking" | "removing" | "scoping"; readonly key: string }

export type AccountsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: AccountsSnapshot }
  | { readonly kind: "failed"; readonly error: AppError }

export type Accounts = {
  readonly load: Accessor<AccountsLoad>
  readonly onMachine: Accessor<boolean>
  readonly machineName: Accessor<string | undefined>
  readonly opened: Accessor<boolean>
  readonly scanning: Accessor<boolean>
  readonly activity: Accessor<AccountActivity | undefined>
  readonly liveChecks: Accessor<Readonly<Record<string, LiveCheck>>>
  readonly scopeErrors: Accessor<Readonly<Record<string, string>>>
  readonly runnable: Accessor<boolean>
  readonly rescan: () => Promise<void>
  readonly select: (harness: Harness, key: string, ids: readonly string[]) => void
  readonly remove: (ids: readonly string[]) => Promise<void>
  readonly check: (id: string) => void
  readonly checkMachine: (harness: Harness) => void
  readonly allowInCloud: (key: string, ids: readonly string[], allowed: boolean) => void
}

function effectiveByProvider(effective: EffectiveAccounts): ReadonlyMap<string, Account> | undefined {
  return effective.kind === "listed" ? new Map(effective.accounts.map((account) => [account.providerId, account])) : undefined
}

function useAccountReads(server: Server) {
  const onMachine = () => server.capabilities()?.localExecution === true
  const list = useQuery(() => server.queries.accounts.list())
  const effective = useQuery(() => server.queries.accounts.effective())
  const logins = useQuery(() => ({ ...server.queries.accounts.machineLogins(), enabled: onMachine() }))
  const machines = useQuery(() => ({ ...server.queries.machines.list(), enabled: onMachine() }))
  const machineName = () => machines.data?.find((machine) => machine.isThisMachine)?.name
  const sources = useQuery(() => server.queries.accounts.sources())
  const queries = [list, effective, logins, sources] as const
  const machineLogins = (): readonly MachineLogin[] | undefined => (onMachine() ? logins.data : [])
  const load = createMemo((): AccountsLoad => {
    const scanned = machineLogins()
    if (list.data && effective.data && scanned && sources.data) {
      const snapshot = { cloudOnly: !onMachine(), stored: list.data, effective: effectiveByProvider(effective.data), machineLogins: scanned, sources: sources.data, scannedAt: Math.max(...queries.map((query) => query.dataUpdatedAt)) }
      return { kind: "ready", snapshot }
    }
    const error = queries.map((query) => query.error).find((candidate) => candidate)
    return error ? { kind: "failed", error: toAppError(error) } : { kind: "loading" }
  })
  return { load, onMachine, machineName, opened: () => load().kind !== "loading", fetching: () => queries.some((query) => query.isFetching) }
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
  return { activity, setActivity, run }
}

async function selectAccount(server: Server, harness: Harness, key: string, ids: readonly string[]) {
  if (key === ORG_ACCOUNT_KEY) return server.accounts.setSource(harness.providerIds, "org")
  await server.accounts.setSource(harness.providerIds, "own")
  return key === MACHINE_LOGIN_KEY ? server.accounts.selectMachineLogin(harness.providerIds) : server.accounts.select(ids)
}

function useCloudConsent(server: Server, activity: Accessor<AccountActivity | undefined>, setActivity: (activity: AccountActivity | undefined) => void) {
  const [scopeErrors, setScopeErrors] = createSignal<Readonly<Record<string, string>>>({})
  const allowInCloud = async (key: string, ids: readonly string[], allowed: boolean) => {
    if (activity()) return
    setActivity({ kind: "scoping", key })
    setScopeErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([entry]) => entry !== key)))
    try {
      await server.accounts.setScope(ids, allowed ? "shared" : "local")
    } catch (error) {
      setScopeErrors((previous) => ({ ...previous, [key]: toAppError(error).message }))
    } finally {
      setActivity(undefined)
    }
  }
  return { scopeErrors, allowInCloud: (key: string, ids: readonly string[], allowed: boolean) => void allowInCloud(key, ids, allowed) }
}

function anyHarnessRunnable(load: AccountsLoad, liveChecks: Readonly<Record<string, LiveCheck>>): boolean {
  return load.kind === "ready" && harnesses.some((harness) => harnessRunnable(harness, load.snapshot, liveChecks))
}

export function useAccounts(): Accounts {
  const server = useServer()
  const reads = useAccountReads(server)
  const { activity, setActivity, run } = useActivity()
  const consent = useCloudConsent(server, activity, setActivity)
  const [rescanning, setRescanning] = createSignal(false)
  const [liveChecks, setLiveChecks] = createSignal<Readonly<Record<string, LiveCheck>>>({})
  const remember = (id: string, check: LiveCheck) => setLiveChecks((previous) => ({ ...previous, [id]: check }))
  return {
    load: reads.load,
    onMachine: reads.onMachine,
    machineName: reads.machineName,
    opened: reads.opened,
    scanning: () => rescanning() || reads.fetching(),
    activity,
    liveChecks,
    scopeErrors: consent.scopeErrors,
    runnable: () => anyHarnessRunnable(reads.load(), liveChecks()),
    rescan: () => run("checking", "", async () => {
      setRescanning(true)
      setLiveChecks({})
      await (reads.onMachine() ? server.accounts.rescan() : server.accounts.refresh()).finally(() => setRescanning(false))
    }),
    select: (harness, key, ids) => void run("selecting", key, () => selectAccount(server, harness, key, ids)),
    remove: (ids) => run("removing", ids[0] ?? "", () => server.accounts.remove(ids)),
    check: (id) =>
      void run("checking", id, async () => {
        const check = await server.accounts.check(id).catch((error: unknown) => ({ verdict: "unknown" as const, reason: toAppError(error).message }))
        remember(id, { at: Date.now(), ...check })
      }),
    checkMachine: (harness) => void run("checking", MACHINE_LOGIN_KEY, () => server.accounts.checkMachineLogin(harness.id)),
    allowInCloud: consent.allowInCloud,
  }
}
