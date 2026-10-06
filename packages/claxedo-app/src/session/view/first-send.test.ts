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

test("first send: a new worktree reads creating, then sending to the created placement", async () => {
  const { send } = firstSend()
  const steps: string[] = []
  let finishCreate: (() => void) | undefined
  const attempt: FirstSendAttempt<string> = async (report) => {
    report({ type: "createStarted", choice: { kind: "newWorktree", root: placementId("pl_root") } })
    steps.push(send.state().kind)
    await new Promise<void>((resolve) => (finishCreate = resolve))
    report({ type: "placementResolved", placementId: created })
    steps.push(send.state().kind)
    return "session"
  }
  const result = send.run(attempt)
  expect(send.state()).toEqual({ kind: "creating", choice: { kind: "newWorktree", root: placementId("pl_root") } })
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

test("first send: Edit message after a refusal ends the attempt with no session and returns to editing", async () => {
  const { send } = firstSend()
  let attempts = 0
  const result = send.run(async () => {
    attempts += 1
    throw new ServerError({ class: "invalid", message: "The model is not available" })
  })
  await settle()
  expect(send.state().kind).toBe("failed")
  send.edit()
  expect(await result).toBeUndefined()
  expect(attempts).toBe(1)
  expect(send.state()).toEqual({ kind: "idle" })
})

test("first send: Retry before any failure does nothing", async () => {
  const { send } = firstSend()
  send.retry()
  expect(send.state()).toEqual({ kind: "idle" })
})

test("first send: Edit message after an answer that was lost opens the session the send created instead of sending a second prompt to it", async () => {
  const { send } = firstSend()
  const checks: string[] = []
  const result = send.run(async () => {
    throw new ServerError({ class: "network", status: 502, message: "Bad gateway" })
  }, { landed: async () => (checks.push("read"), "session") })
  await settle()
  send.edit()
  expect(await result).toBe("session")
  expect(checks).toEqual(["read"])
})

test("first send: Edit message after a lost answer whose session never landed returns to editing", async () => {
  const { send } = firstSend()
  let reads = 0
  const result = send.run(async () => {
    throw new ServerError({ class: "internal", status: 500, message: "boom" })
  }, { landed: async () => (reads += 1, undefined) })
  await settle()
  send.edit()
  expect(await result).toBeUndefined()
  expect(reads).toBe(1)
  expect(send.state()).toEqual({ kind: "idle" })
})

test("first send: Edit message after a definite refusal never asks whether the send landed", async () => {
  const { send } = firstSend()
  let reads = 0
  const result = send.run(async () => {
    throw new ServerError({ class: "invalid", message: "The model is not available" })
  }, { landed: async () => (reads += 1, "session") })
  await settle()
  send.edit()
  expect(await result).toBeUndefined()
  expect(reads).toBe(0)
})

test("first send: a failed landed check shows its error and asks again on the next Edit", async () => {
  const { send } = firstSend()
  let reads = 0
  const result = send.run(async () => {
    throw new ServerError({ class: "network", message: "The server could not be reached" })
  }, {
    landed: async () => {
      reads += 1
      if (reads === 1) throw new ServerError({ class: "auth", message: "Sign in again" })
      return undefined
    },
  })
  await settle()
  send.edit()
  await settle()
  const state = send.state()
  expect(state.kind === "failed" && state.error.message).toBe("Sign in again")
  send.edit()
  expect(await result).toBeUndefined()
  expect(reads).toBe(2)
})
