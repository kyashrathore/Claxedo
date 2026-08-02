import { describe, expect, test } from "vitest"
import { shareCredentialsWithCloud, shareCredentialWithCloud } from "./cloud-credentials-api"

type Call = { url: string; method?: string; body?: string }

function recorder(behaviour: (credentialId: string) => Response | Error = () => new Response("{}")) {
  const calls: Call[] = []
  const request = async (input?: { credentialId?: string; action?: string }, init?: RequestInit) => {
    const credentialId = input?.credentialId ?? ""
    calls.push({
      url: `${credentialId}/${input?.action ?? ""}`,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    const result = behaviour(credentialId)
    if (result instanceof Error) throw result
    return result
  }
  return { calls, request: request as never }
}

describe("sharing a credential with the cloud", () => {
  test("PATCHes the scope route rather than re-saving the secret", async () => {
    const { calls, request } = recorder()
    await shareCredentialWithCloud({ credentialId: "cred_1", request })
    expect(calls).toEqual([{ url: "cred_1/scope", method: "PATCH", body: JSON.stringify({ scope: "shared" }) }])
  })

  test("reports success", async () => {
    const { request } = recorder()
    expect(await shareCredentialWithCloud({ credentialId: "cred_1", request })).toEqual({
      credentialId: "cred_1",
      ok: true,
    })
  })

  test("maps an unsupported server to copy that says so", async () => {
    const { request } = recorder(() => new Error("Credential scope updates are unavailable"))
    const outcome = await shareCredentialWithCloud({ credentialId: "cred_1", request })
    expect(outcome).toEqual({
      credentialId: "cred_1",
      ok: false,
      reason: "This server can't share credentials with cloud sandboxes yet.",
    })
  })

  test("maps a missing credential to a repair action", async () => {
    const { request } = recorder(() => new Error("Credential not found"))
    const outcome = await shareCredentialWithCloud({ credentialId: "cred_1", request })
    expect(outcome).toMatchObject({ ok: false, reason: "That credential is no longer saved. Reconnect it and try again." })
  })

  test("never leaks a raw server message", async () => {
    const { request } = recorder(() => new Error("credential_scope_update_failed: pg: deadlock detected"))
    const outcome = await shareCredentialWithCloud({ credentialId: "cred_1", request })
    expect(outcome).toEqual({ credentialId: "cred_1", ok: false, reason: "Couldn't share this credential. Try again." })
  })
})

describe("sharing several credentials", () => {
  test("one failure does not discard the successes", async () => {
    // The bug this replaces: a first-failure-wins reduction reported a partially
    // successful batch as a total failure and dropped the credentials that worked.
    const { request } = recorder((id) => id === "cred_2" ? new Error("Credential not found") : new Response("{}"))
    const outcomes = await shareCredentialsWithCloud({ credentialIds: ["cred_1", "cred_2", "cred_3"], request })
    expect(outcomes.map((outcome) => [outcome.credentialId, outcome.ok])).toEqual([
      ["cred_1", true],
      ["cred_2", false],
      ["cred_3", true],
    ])
  })

  test("settles every credential it was given", async () => {
    const { calls, request } = recorder()
    await shareCredentialsWithCloud({ credentialIds: ["a", "b"], request })
    expect(calls.map((call) => call.url)).toEqual(["a/scope", "b/scope"])
  })

  test("an empty selection makes no requests", async () => {
    const { calls, request } = recorder()
    expect(await shareCredentialsWithCloud({ credentialIds: [], request })).toEqual([])
    expect(calls).toEqual([])
  })
})
