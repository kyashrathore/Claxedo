/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { ProviderAuthorization } from "@/server"
import type { ConnectMethodOption } from "./connect-methods"
import { connectSubmit } from "./connect-submit"

type Step = { readonly type?: ConnectMethodOption["type"]; readonly state?: "pending" | "auto" | "code" | "error"; readonly loading?: boolean; readonly replaces?: string; readonly saving?: boolean }

function form(step: Step) {
  const calls: string[] = []
  const option = step.type === undefined ? undefined : ({ index: 2, type: step.type } as ConnectMethodOption)
  const authorization = { url: "https://example.test", method: "code", instructions: "" } as unknown as ProviderAuthorization
  const source = {
    store: { state: step.state, saving: step.saving ?? false, code: " 123 ", authorization: step.state === undefined ? undefined : authorization },
    selected: () => option,
    loadingMethods: () => step.loading ?? false,
    methodsError: () => undefined,
    pastes: () => step.type === "api" || step.type === "token",
    replaces: () => step.replaces,
    saveKey: async () => void calls.push("save"),
    startOAuth: async (index: number) => void calls.push(`start ${index}`),
    finishOAuth: async (code: string) => void calls.push(`finish ${code}`),
  }
  return { submit: connectSubmit(source as unknown as Parameters<typeof connectSubmit>[0]), calls }
}

test("connect drawer: the one submit does the chosen step, and nothing before a method is chosen", () => {
  expect(form({}).submit).toMatchObject({ enabled: false })
  expect(form({ type: "api", loading: true }).submit).toMatchObject({ enabled: false })
  const paste = form({ type: "api" })
  expect(paste.submit).toMatchObject({ label: "common.continue", enabled: true, busy: false })
  paste.submit.run()
  expect(paste.calls).toEqual(["save"])
  expect(form({ type: "token", replaces: "Ada" }).submit.label).toBe("provider.connect.replace")
  expect(form({ type: "api", saving: true }).submit.busy).toBe(true)
  const start = form({ type: "oauth" })
  expect(start.submit.label).toBe("provider.connect.oauth.start")
  start.submit.run()
  expect(start.calls).toEqual(["start 2"])
  const retry = form({ type: "oauth", state: "error" })
  retry.submit.run()
  expect(retry.calls).toEqual(["start 2"])
  expect(form({ type: "oauth", state: "auto" }).submit).toMatchObject({ busy: true, busyLabel: "provider.connect.status.waiting" })
  expect(form({ type: "oauth", state: "pending" }).submit).toMatchObject({ busy: true, busyLabel: "provider.connect.status.inProgress" })
  const code = form({ type: "oauth", state: "code" })
  code.submit.run()
  expect(code.calls).toEqual(["finish 123"])
})
