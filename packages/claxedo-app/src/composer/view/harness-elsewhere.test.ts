/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { ServerError } from "@/server"
import type { SendState } from "../model"
import type { useComposerText } from "../text"
import { createHarnessElsewhereRefusal, harnessElsewhereNotice } from "./harness-elsewhere"

const HOSTED_ELSEWHERE = new ServerError({
  class: "conflict",
  code: "workspace_harness_hosted_elsewhere",
  message: "Pi runs in its own session host on a cloud workspace, not in the workspace's runtime. Start a new Pi session to use it here.",
})

const t = ((key: string) => key) as ReturnType<typeof useComposerText>

function refusalOf() {
  const [state, setState] = createSignal<SendState>({ kind: "editing" })
  const refusal = createRoot(() => createHarnessElsewhereRefusal(state))
  return { refusal, setState }
}

test("a send refused because the picked harness runs in another host is the composer's notice, with the server's sentence and a way out, until the next send", () => {
  const { refusal, setState } = refusalOf()
  setState({ kind: "sending", clientRequestId: "c1" })
  setState({ kind: "rejected", error: HOSTED_ELSEWHERE })
  setState({ kind: "editing" })
  const actions = { startNewSession: () => undefined, keepSessionHarness: () => undefined }
  expect(harnessElsewhereNotice(refusal.refusal(), t, actions)).toEqual({
    kind: "harness-hosted-elsewhere",
    tone: "warning",
    message: HOSTED_ELSEWHERE.message,
    action: { label: "composer.harnessElsewhere.startNew", run: actions.startNewSession },
    secondaryAction: { label: "composer.harnessElsewhere.keep", run: actions.keepSessionHarness },
  })
  setState({ kind: "sending", clientRequestId: "c2" })
  expect(refusal.refusal()).toBeUndefined()
})

test("any other refused send is no harness notice, and a dismissed notice is gone", () => {
  const { refusal, setState } = refusalOf()
  setState({ kind: "rejected", error: new ServerError({ class: "network", message: "Failed to fetch" }) })
  expect(refusal.refusal()).toBeUndefined()
  setState({ kind: "rejected", error: HOSTED_ELSEWHERE })
  refusal.dismiss()
  expect(refusal.refusal()).toBeUndefined()
})
