/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId, ServerError } from "@/server"
import { createFirstSend, type FirstSendAttempt } from "./first-send"

const created = placementId("ws_new")

async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}

function firstSend() {
  return createRoot((dispose) => ({ dispose, send: createFirstSend() }))
}

test("first send: a new cloud workspace reads creating, then sending to the created placement", async () => {
  const { send } = firstSend()
  const steps: string[] = []
  let finishCreate: (() => void) | undefined
  const attempt: FirstSendAttempt<string> = async (report) => {
    report({ type: "createStarted", choice: { kind: "newCloud", name: "ux-audit" } })
    steps.push(send.state().kind)
    await new Promise<void>((resolve) => (finishCreate = resolve))
    report({ type: "placementResolved", placementId: created })
    steps.push(send.state().kind)
    return "session"
  }
  const result = send.run(attempt)
  expect(send.state()).toEqual({ kind: "creating", choice: { kind: "newCloud", name: "ux-audit" } })
  finishCreate?.()
  expect(await result).toBe("session")
  expect(steps).toEqual(["creating", "sending"])
  expect(send.state()).toEqual({ kind: "sending", placementId: created })
})

test("first send: a refused send shows the server's message and waits for Retry, which sends it again", async () => {
  const { send } = firstSend()
  let attempts = 0
  const attempt: FirstSendAttempt<string> = async (report) => {
    attempts += 1
    report({ type: "placementResolved", placementId: created })
    if (attempts === 1) throw new ServerError({ class: "conflict", code: "cloud_runtime_boot_failed", message: "The cloud workspace could not start: branch main is missing" })
    return "session"
  }
  const hooks: string[] = []
  let settled = false
  const result = send.run(attempt, { failed: () => hooks.push("failed"), retried: () => hooks.push("retried") }).then((value) => {
    settled = true
    return value
  })
  await settle()
  const state = send.state()
  expect(state.kind).toBe("failed")
  expect(state.kind === "failed" && state.error.message).toBe("The cloud workspace could not start: branch main is missing")
  expect(settled).toBe(false)
  expect(attempts).toBe(1)
  expect(hooks).toEqual(["failed"])

  send.retry()
  expect(await result).toBe("session")
  expect(attempts).toBe(2)
  expect(hooks).toEqual(["failed", "retried"])
  expect(send.state()).toEqual({ kind: "sending", placementId: created })
})

test("first send: closing the draft while a send waits for Retry ends it, so the composer gets the text back", async () => {
  const { send, dispose } = firstSend()
  const result = send.run(async () => {
    throw new ServerError({ class: "network", message: "The server could not be reached" })
  })
  await settle()
  expect(send.state().kind).toBe("failed")
  dispose()
  await expect(result).rejects.toMatchObject({ code: "first_send_abandoned" })
})

test("first send: Retry before any failure does nothing", async () => {
  const { send } = firstSend()
  send.retry()
  expect(send.state()).toEqual({ kind: "idle" })
})
