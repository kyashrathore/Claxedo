import { createSignal } from "solid-js"
import { useErrorCopy } from "@/i18n"
import { toAppError } from "@/server"
import { showToast } from "@/ui"

export function createPendingWrite() {
  const errorCopy = useErrorCopy("marketplace")
  const [pending, setPending] = createSignal<string>()
  const run = async (pluginId: string, failure: string, work: () => Promise<void>) => {
    setPending(pluginId)
    try {
      await work()
    } catch (error) {
      showToast({ title: failure, description: errorCopy(toAppError(error)).message })
    } finally {
      setPending(undefined)
    }
  }
  return { pending, run }
}
