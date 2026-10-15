import { createSignal } from "solid-js"
import { toAppError, useServer } from "@/server"
import { showToast } from "@/ui"
import { useAccountsText } from "./i18n"
import type { LiveCheck } from "./model"

export type KeyActivity<Kind extends string> = { readonly kind: Kind; readonly key: string }

export function createKeyActions<Kind extends string>() {
  const server = useServer()
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
  const verify = async (id: string) => {
    const check = await server.accounts.check(id).catch((error: unknown) => ({ verdict: "unknown" as const, reason: toAppError(error).message }))
    setLiveChecks((previous) => ({ ...previous, [id]: { at: Date.now(), ...check } }))
  }
  return { activity, liveChecks, run, verify }
}
