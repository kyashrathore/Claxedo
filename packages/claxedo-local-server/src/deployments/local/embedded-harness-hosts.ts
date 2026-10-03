import { clearOpaqueTimer, errorMessage } from "@claxedo/helpers"
import { createSharedHarnessHosts, type SharedHarnessHosts } from "@claxedo/workspace-runtime"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "embedded-harness-hosts" })

let hosts: SharedHarnessHosts | undefined

/** The Codex app-servers and Cursor SDK hosts every embedded workspace runtime of this process shares. */
export function embeddedHarnessHosts(): SharedHarnessHosts {
  hosts ??= createSharedHarnessHosts({
    clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: clearOpaqueTimer },
    log: { debug: (message, fields) => log.info(message, fields), info: (message, fields) => log.info(message, fields),
      warn: (message, fields) => log.warn(message, fields), error: (message, fields) => log.error(message, fields) },
  })
  return hosts
}

/** Retires them once every embedded runtime has been disposed; the next mount creates new ones. */
export async function retireEmbeddedHarnessHosts(): Promise<boolean> {
  const retiring = hosts
  hosts = undefined
  try {
    await retiring?.dispose()
    return true
  } catch (error) {
    log.error("the shared harness processes did not retire", { error: errorMessage(error) })
    return false
  }
}
