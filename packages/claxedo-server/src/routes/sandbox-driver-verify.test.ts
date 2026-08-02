import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { sandboxDriverRoutes } from "./sandbox-driver-routes"
import type { ControlPlaneCredentials } from "../authority/services"

/**
 * A sandbox provider key used to be accepted on sight and only discovered
 * broken at workspace creation — long after the user believed setup had
 * succeeded, and with nothing at that point tying the failure back to the key
 * they pasted. These pin the verdict at paste time, and pin the line between a
 * rejection (the provider said no) and an inconclusive one (we couldn't ask).
 */

let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-driver-verify-"))
  process.env.CLAXEDO_DATA_DIR = tempDataDir
})

afterEach(() => {
  fs.rmSync(path.join(tempDataDir, "user-agent-config.json"), { force: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function recordingCredentials() {
  const stored: Array<{ provider_id: string; kind: string; secret: string }> = []
  const credentials = {
    listCredentials: async () => stored.map((item) => ({ provider_id: item.provider_id, status: "available" })),
    putCredential: async (input: { provider_id: string; kind: string; secret: string }) => {
      stored.push(input)
      return input
    },
    deleteCredentialsByProvider: async () => 0,
  } as unknown as ControlPlaneCredentials
  return { credentials, stored }
}

function respond(input: { ok?: boolean; status?: number; body?: string }) {
  const calls: string[] = []
  const stub = (async (url: string | URL) => {
    calls.push(String(url))
    return {
      ok: input.ok ?? true,
      status: input.status ?? (input.ok === false ? 400 : 200),
      text: async () => input.body ?? "",
      body: undefined,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { stub, calls }
}

const OFFLINE = (async () => {
  throw new Error("getaddrinfo ENOTFOUND app.daytona.io")
}) as unknown as typeof fetch

function appWith(credentials: ControlPlaneCredentials, fetchImpl?: typeof fetch) {
  return new Hono().route(
    "/api/workspace",
    sandboxDriverRoutes(undefined, { credentials, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
  )
}

function putAuth(app: Hono, id: string, auth: Record<string, string>) {
  return app.request(`/api/workspace/drivers/${id}/auth`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth, default: true }),
  })
}

describe("a key the provider rejects is refused at paste time", () => {
  test("the save is rejected rather than stored", async () => {
    const { credentials, stored } = recordingCredentials()
    const transport = respond({ ok: false, status: 401, body: "unauthorized" })

    const response = await putAuth(appWith(credentials, transport.stub), "daytona", { api_key: "dtn_bad" })

    expect(response.status).toBe(400)
    // Nothing was written: a rejected key must not sit in the registry looking
    // configured, which is precisely the state that produced the late failure.
    expect(stored).toHaveLength(0)
  })

  test("the refusal names what happened instead of returning a raw code", async () => {
    const { credentials } = recordingCredentials()
    const transport = respond({ ok: false, status: 401, body: "unauthorized" })

    const response = await putAuth(appWith(credentials, transport.stub), "daytona", { api_key: "dtn_bad" })
    const body = (await response.json()) as { error: { code: string; reason?: string } }

    expect(body.error.code).toBe("sandbox_driver_key_rejected")
    // The destination surface renders `reason` verbatim, so it has to be a
    // sentence with a repair action, never a code.
    expect(body.error.reason).toBe("The provider rejected that key. Check it was copied whole, then save it again.")
  })

  test("a provider reporting no billing says so rather than blaming the key", async () => {
    const { credentials } = recordingCredentials()
    const transport = respond({ ok: false, status: 402, body: "payment required" })

    const response = await putAuth(appWith(credentials, transport.stub), "box", { api_key: "box_key" })
    const body = (await response.json()) as { error: { code: string; reason?: string } }

    expect(response.status).toBe(400)
    expect(body.error.reason).toBe(
      "That key works, but the provider reports no active billing on the account. Add billing, then save it again.",
    )
  })
})

describe("a key that could not be checked is still saved", () => {
  /**
   * An offline laptop says nothing about the key. Refusing the save here would
   * make a working key unusable exactly when the user cannot diagnose why —
   * network down is not a bad key.
   */
  test("an unreachable provider does not block the save", async () => {
    const { credentials, stored } = recordingCredentials()

    const response = await putAuth(appWith(credentials, OFFLINE), "daytona", { api_key: "dtn_key" })

    expect(response.status).toBe(200)
    expect(stored).toHaveLength(1)
  })

  test("the response reports the unchecked state rather than claiming it verified", async () => {
    const { credentials } = recordingCredentials()

    const response = await putAuth(appWith(credentials, OFFLINE), "daytona", { api_key: "dtn_key" })
    const body = (await response.json()) as { verification?: { state: string; reason?: string } }

    expect(body.verification?.state).toBe("unknown")
    expect(body.verification?.reason).toBe("Couldn't reach the provider to check this key — it was saved as-is.")
  })

  test("a provider with no documented check is saved and reported unverifiable", async () => {
    const { credentials, stored } = recordingCredentials()
    const transport = respond({})

    const response = await putAuth(appWith(credentials, transport.stub), "modal", {
      token_id: "ak-1",
      token_secret: "as-1",
    })
    const body = (await response.json()) as { verification?: { state: string; reason?: string } }

    expect(response.status).toBe(200)
    expect(stored).toHaveLength(1)
    expect(body.verification?.state).toBe("unknown")
    expect(body.verification?.reason).toBe("Claxedo can't check this provider yet — the key was saved as-is.")
    // Nothing was spent asking: an unverifiable provider must not be probed.
    expect(transport.calls).toHaveLength(0)
  })
})

describe("a key the provider accepts", () => {
  test("is saved and reported working", async () => {
    const { credentials, stored } = recordingCredentials()
    const transport = respond({})

    const response = await putAuth(appWith(credentials, transport.stub), "daytona", { api_key: "dtn_good" })
    const body = (await response.json()) as {
      verification?: { state: string }
      drivers: Array<{ id: string; configured: boolean }>
    }

    expect(response.status).toBe(200)
    expect(stored).toHaveLength(1)
    expect(body.verification?.state).toBe("working")
    expect(body.drivers.find((item) => item.id === "daytona")?.configured).toBe(true)
    expect(transport.calls[0]).toBe("https://app.daytona.io/api/api-keys/current")
  })

  /**
   * A quota-capped account authenticated — the provider answered and will
   * again. Blocking the save would reject a key that is fine.
   */
  test("a rate-capped provider still counts as working", async () => {
    const { credentials, stored } = recordingCredentials()
    const transport = respond({ ok: false, status: 429, body: "too many requests" })

    const response = await putAuth(appWith(credentials, transport.stub), "daytona", { api_key: "dtn_good" })
    const body = (await response.json()) as { verification?: { state: string } }

    expect(response.status).toBe(200)
    expect(stored).toHaveLength(1)
    expect(body.verification?.state).toBe("working")
  })

  test("the verdict rides on the drivers listing every read returns", async () => {
    const { credentials } = recordingCredentials()
    const transport = respond({})

    const response = await putAuth(appWith(credentials, transport.stub), "daytona", { api_key: "dtn_good" })
    const body = (await response.json()) as {
      drivers: Array<{ id: string; verification?: { state: string } }>
    }

    // The step's "ready for cloud sessions" line is backed by this field, so it
    // must be on the driver row rather than only on the save response.
    expect(body.drivers.find((item) => item.id === "daytona")?.verification?.state).toBe("working")
  })
})

describe("verification runs before the credential is stored", () => {
  test("a rejected key leaves no default-driver flip behind", async () => {
    const { credentials } = recordingCredentials()
    const transport = respond({ ok: false, status: 401, body: "unauthorized" })

    await putAuth(appWith(credentials, transport.stub), "daytona", { api_key: "dtn_bad" })

    const config = path.join(tempDataDir, "user-agent-config.json")
    expect(fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "").toBe("")
  })

  test("a rejected key is never written to disk in plaintext", async () => {
    const { credentials } = recordingCredentials()
    const transport = respond({ ok: false, status: 401, body: "unauthorized" })

    await putAuth(appWith(credentials, transport.stub), "daytona", { api_key: "dtn_secret_value" })

    const config = path.join(tempDataDir, "user-agent-config.json")
    const written = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : ""
    expect(written).not.toContain("dtn_secret_value")
  })
})
