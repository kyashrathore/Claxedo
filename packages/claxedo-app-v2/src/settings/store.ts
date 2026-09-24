import { createSignal, onMount, type Accessor } from "solid-js"
import { useQueryClient } from "@tanstack/solid-query"
import type { AppError } from "@/server"
import { MACHINE_LOGIN_KEY, type Harness, type LiveCheck, type MachineLogin } from "./accounts"
import {
  ACCOUNTS_FRESH_MS,
  accountsQuery,
  activateAccount,
  activateMachineLogin,
  loadMachineLogins,
  removeAccount,
  scanAccounts,
  storeApiKey,
  verifyAccount,
} from "./api"
import { accountsMachine, type AccountActivity, type AccountsState } from "./model"

export type Accounts = {
  readonly state: Accessor<AccountsState>
  readonly activity: Accessor<AccountActivity | undefined>
  readonly liveChecks: Accessor<Readonly<Record<string, LiveCheck>>>
  readonly scan: (input?: { fresh?: boolean }) => Promise<void>
  readonly select: (harness: Harness, key: string, ids: readonly string[]) => Promise<void>
  readonly remove: (ids: readonly string[]) => Promise<void>
  readonly check: (credentialId: string) => Promise<void>
  readonly checkMachine: (harness: Harness) => Promise<void>
  readonly addKey: (harness: Harness, label: string, secret: string) => Promise<void>
}

const asAppError = (error: unknown): AppError =>
  typeof error === "object" && error !== null && "class" in error
    ? (error as AppError)
    : { class: "internal", message: error instanceof Error ? error.message : String(error), retryable: false }

export function createAccounts(): Accounts {
  const queryClient = useQueryClient()
  const accounts = accountsMachine()
  const [activity, setActivity] = createSignal<AccountActivity>()
  const [liveChecks, setLiveChecks] = createSignal<Readonly<Record<string, LiveCheck>>>({})

  const scan = async (input: { fresh?: boolean } = {}) => {
    accounts.send({ type: "scan" })
    try {
      const snapshot = await queryClient.fetchQuery({ ...accountsQuery(), staleTime: input.fresh ? 0 : ACCOUNTS_FRESH_MS })
      setLiveChecks({})
      accounts.send({ type: "scanned", snapshot })
    } catch (error) {
      accounts.send({ type: "failed", error: asAppError(error) })
    }
  }

  const busy = async (kind: AccountActivity["kind"], key: string, task: () => Promise<void>) => {
    setActivity({ kind, key })
    try {
      await task()
    } finally {
      setActivity(undefined)
    }
  }

  const patchMachineLogins = (harness: Harness, logins: readonly MachineLogin[]) => {
    const state = accounts.state()
    if (state.kind !== "ready") return
    const machineLogins = [...state.snapshot.machineLogins.filter((login) => login.harness !== harness.id), ...logins]
    const snapshot = { ...state.snapshot, machineLogins }
    queryClient.setQueryData(accountsQuery().queryKey, snapshot)
    accounts.send({ type: "scanned", snapshot })
  }

  onMount(() => void scan())

  return {
    state: accounts.state,
    activity,
    liveChecks,
    scan,
    select: (harness, key, ids) =>
      busy("selecting", key, async () => {
        if (key === MACHINE_LOGIN_KEY) await activateMachineLogin(harness.providerIds)
        else await activateAccount(ids)
        await scan({ fresh: true })
      }),
    remove: (ids) =>
      busy("removing", ids[0] ?? "", async () => {
        await removeAccount(ids)
        await scan({ fresh: true })
      }),
    check: (credentialId) =>
      busy("checking", credentialId, async () => {
        try {
          const verified = await verifyAccount(credentialId)
          setLiveChecks((previous) => ({ ...previous, [credentialId]: { at: Date.now(), verdict: verified.verdict, ...(verified.usage ? { usage: verified.usage } : {}) } }))
        } catch (error) {
          setLiveChecks((previous) => ({ ...previous, [credentialId]: { at: Date.now(), verdict: "unknown", reason: asAppError(error).message } }))
        }
        const snapshot = await scanAccounts()
        queryClient.setQueryData(accountsQuery().queryKey, snapshot)
        accounts.send({ type: "scanned", snapshot })
      }),
    checkMachine: (harness) =>
      busy("checking", MACHINE_LOGIN_KEY, async () => {
        patchMachineLogins(harness, await loadMachineLogins({ harness: harness.id, fresh: true }))
      }),
    addKey: (harness, label, secret) =>
      busy("connecting", harness.id, async () => {
        await storeApiKey({ providerId: harness.connectProvider, label, secret })
        await scan({ fresh: true })
      }),
  }
}
