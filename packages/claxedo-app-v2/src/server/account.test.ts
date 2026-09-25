/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createHostedAccount } from "./account"
import { ServerError } from "./errors"

const failing = (message: string) => createHostedAccount(async () => Promise.reject(new Error(message)))

async function failure(promise: Promise<unknown>): Promise<ServerError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ServerError) return error
    throw error
  }
  throw new Error("expected the operation to fail")
}

test("hosted account: an answer is decoded by its operation's own decoder", async () => {
  const account = createHostedAccount(async () => ({ workspaces: [{ id: "ws_1" }] }))
  expect(await account.run("workspace.list.provisioner")).toEqual({ workspaces: [{ id: "ws_1" }] })
})

test("hosted account: a changed shape fails where it arrives, naming the operation", async () => {
  const error = await failure(createHostedAccount(async () => ({ rows: [] })).run("workspace.list.provisioner"))
  expect(error.class).toBe("internal")
  expect(error.message).toContain("workspace.list.provisioner")
})

test("hosted account: main's HTTP failure keeps its status class and the server's message", async () => {
  const body = JSON.stringify({ detail: "workspace.resolve failed (404)", body: { error: { code: "workspace_not_found", message: "No such workspace" } } })
  const error = await failure(failing(`Error invoking remote method 'claxedo.account.operation:workspace.resolve': Error: HOSTED_HTTP 404 ${body}`).run("workspace.resolve"))
  expect({ class: error.class, status: error.status, code: error.code, message: error.message }).toEqual({
    class: "not_found",
    status: 404,
    code: "workspace_not_found",
    message: "No such workspace",
  })
})

test("hosted account: a failure with no body reads main's detail", async () => {
  const error = await failure(failing(`HOSTED_HTTP 503 ${JSON.stringify({ detail: "The control plane is down", body: null })}`).run("account.mode"))
  expect({ class: error.class, retryable: error.retryable, message: error.message }).toEqual({ class: "network", retryable: true, message: "The control plane is down" })
})

test("hosted account: an account main no longer holds is an auth failure; anything else did not reach the control plane", async () => {
  expect((await failure(failing("Error: not signed in").run("account.mode"))).class).toBe("auth")
  const unreachable = await failure(failing("fetch failed").run("account.mode"))
  expect(unreachable.class).toBe("network")
  expect(unreachable.message).toContain("account.mode")
})
