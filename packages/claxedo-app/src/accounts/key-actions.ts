import { createSignal } from "solid-js"
import { toAppError, type AccountCheck, type SavedSandboxKey } from "@/server"
import { showToast } from "@/ui"
import { useAccountsText } from "./i18n"
import type { LiveCheck } from "./model"

export type KeyActivity<Kind extends string> = { readonly kind: Kind; readonly key: string }

export function createKeyActions<Kind extends string>(check: (id: string) => Promise<AccountCheck>) {
  const t = useAccountsText()
  const [activity, setActivity] = createSignal<KeyActivity<Kind>>()
  const [liveChecks, setLiveChecks] = createSignal<Readonly<Record<string, LiveCheck>>>({})
  const run = async (kind: Kind, key: string, task: () => Promise<unknown>) => {
    setActivity(() => ({ kind, key }))
    try {
      await task()
      return true
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
      return false
    } finally {
      setActivity(undefined)
    }
  }
  const record = (id: string, checked: SavedSandboxKey["check"]) => {
    const shown = "error" in checked ? { verdict: "unknown" as const, reason: toAppError(checked.error).message } : checked
    setLiveChecks((previous) => ({ ...previous, [id]: { at: Date.now(), ...shown } }))
  }
  const verify = async (id: string) => record(id, await check(id).then((checked) => checked, (error: unknown) => ({ error })))
  return { activity, liveChecks, run, verify, record }
}
