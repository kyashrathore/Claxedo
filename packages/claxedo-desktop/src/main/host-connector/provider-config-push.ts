/**
 * Hands one opened provider-configuration revision to the daemon, and keeps
 * the daemon holding it.
 *
 * The daemon owns the workspace runtimes, so the credential rows a turn
 * resolves have to reach it from the process that opened them (the connector
 * child, through main). Main forwards the text without parsing it: the
 * plaintext exists here only between the child's message and this PUT, and
 * nothing in this process reads a provider's value out of it.
 *
 * A push that arrives before the daemon is listening waits for it, and only
 * the latest revision is delivered once it is: two revisions that landed
 * during startup would otherwise reach the daemon in whichever order their
 * fetches completed.
 *
 * The daemon holds the rows in memory alone, so a daemon that restarts mid
 * session loses them while the control plane still records the revision as
 * acked — the child acked the ciphertext write, which is a different fact.
 * `reconcile` closes that: it reads back what the daemon holds and re-pushes
 * the retained revision when it trails. Re-pushing the same revision is a
 * no-op at the daemon, so this is safe to run on every beat.
 */

import { asRecord } from "../../shared/json-read"
import type { HostConnectorProviderConfigReady } from "./child-protocol"

export type HostProviderConfigPush = {
  push: (config: HostConnectorProviderConfigReady) => Promise<void>
  reconcile: () => Promise<void>
}

export function setupHostProviderConfigPush(input: {
  serverUrl: () => Promise<string>
  request?: (url: string, init?: RequestInit) => Promise<Response>
  log: { info(message: string): void; warn(message: string): void }
}): HostProviderConfigPush {
  const request = input.request ?? fetch
  let latest: HostConnectorProviderConfigReady | undefined

  const endpoint = async () => new URL("/api/claxedo/host-provider-config", await input.serverUrl()).toString()

  const deliver = async (config: HostConnectorProviderConfigReady) => {
    const response = await request(await endpoint(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: config.revision, providers: config.providers }),
    })
    const body = await response.text()
    // The daemon's answer names the revision it holds and how many rows it
    // read; a refusal here is the only place the machine learns a pushed
    // row was unreadable, so it must be in the log.
    input.log.info(
      `[host-provider-config] pushed revision=${String(config.revision)} -> ${String(response.status)} ${body.slice(0, 200)}`,
    )
  }

  return {
    async push(config) {
      latest = config
      try {
        // Waiting for the daemon is where two startup revisions overtake each
        // other, so the newer one is decided after that wait, not before it.
        await input.serverUrl()
        if (latest !== config) return
        await deliver(config)
      } catch (error) {
        input.log.warn(`[host-provider-config] push failed: ${String(error)}`)
      }
    },
    async reconcile() {
      const config = latest
      if (!config) return
      try {
        const response = await request(await endpoint())
        if (!response.ok) {
          input.log.warn(`[host-provider-config] state read -> ${String(response.status)}`)
          return
        }
        const held = asRecord(await response.json())?.revision
        if (typeof held === "number" && held >= config.revision) return
        input.log.info(
          `[host-provider-config] daemon holds ${String(held)}, re-pushing revision=${String(config.revision)}`,
        )
        if (latest !== config) return
        await deliver(config)
      } catch (error) {
        input.log.warn(`[host-provider-config] reconcile failed: ${String(error)}`)
      }
    },
  }
}
