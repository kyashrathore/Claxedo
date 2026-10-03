import { expect, test } from "bun:test"
import type { AccountState } from "./account/account-service"
import { setupAccountDaemonSync } from "./account-daemon-sync"
import { recordingDaemon } from "./test-support/daemon-fetch"

test("account daemon composition clears before restore then follows signed/unsigned account state", async () => {
  let ready: () => void = () => {}
  const restored = new Promise<void>((resolve) => { ready = resolve })
  let state: AccountState = { status: "unsigned" }
  const operations: string[] = []
  const { daemon, requests } = recordingDaemon()
  const grant = { token: "scoped-only", actorId: "canonical_actor", orgId: "canonical_org", expiresAt: Date.now() + 300_000 }
  const sync = setupAccountDaemonSync({
    account: {
      ready: restored,
      state: () => state,
      run: async (name) => {
        operations.push(name)
        return name === "session.cleanup.grant.desktop" ? grant : { status: 200, body: { revision: 1 } }
      },
    },
    daemon,
    coreOrigin: "https://core.example",
    log: { info: () => {}, warn: () => {} },
  })
  const settle = async () => { for (let index = 0; index < 60; index++) await Promise.resolve() }
  await settle()
  expect(operations).toEqual([])
  expect(requests.map((request) => request.body)).toEqual([{ capability: null }])
  state = { status: "signed", identity: { userId: "display_user" } }
  ready()
  await settle()
  expect(operations).toContain("session.cleanup.grant.desktop")
  expect(operations).toContain("agentPlugins.runtimeSelf")
  expect(requests.filter((request) => request.url.endsWith("/daemon/session-cleanup")).at(-1)?.body).toEqual({ capability: { ...grant, origin: "https://core.example" } })
  sync.follow({ status: "unsigned" })
  await settle()
  expect(requests.filter((request) => request.url.endsWith("/daemon/session-cleanup")).at(-1)?.body).toEqual({ capability: null })
  await sync.stop()
})
