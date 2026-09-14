import { describe, expect, test } from "vitest"
import { probeDiscoveredCredential } from "@claxedo/server-core/credentials/operations/probe"
import type { LocalCredentialItem } from "@claxedo/server-core/credentials/operations/sync"

/**
 * `probeDiscoveredCredential` is provider-agnostic — it routes through
 * `verifyCredential` and maps whatever comes back. These pin that a sandbox
 * provider key discovered on this machine earns the same live verdict an AI
 * credential does, not a flat "can't check this provider".
 */

function item(input: Partial<LocalCredentialItem> = {}): LocalCredentialItem {
  return {
    provider_id: "daytona",
    kind: "sandbox_driver",
    source: "local_only",
    label: "Synced from local sandbox driver config",
    secret: JSON.stringify({ api_key: "dtn_key" }),
    ...input,
  } as LocalCredentialItem
}

function respond(input: { ok?: boolean; status?: number; body?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const stub = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: input.ok ?? true,
      status: input.status ?? (input.ok === false ? 400 : 200),
      text: async () => input.body ?? "",
      body: undefined,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { stub, calls }
}

function authorization(call: { init: RequestInit | undefined } | undefined) {
  return new Headers(call?.init?.headers).get("authorization")
}

describe("discovered sandbox provider keys get live verdicts", () => {
  test("a working key reads as working, not as an uncheckable provider", async () => {
    const transport = respond()

    const probe = await probeDiscoveredCredential(item(), { fetch: transport.stub })

    // The verdict travels with the probe so the row that is saved from it reads
    // as checked without a second request against the user's quota.
    expect(probe).toEqual({ state: "working", health: "ok" })
    expect(transport.calls[0]?.url).toBe("https://app.daytona.io/api/api-keys/current")
    // The discovered key itself is what the provider answers about; a probe
    // that authenticated as anything else would verify the wrong credential.
    expect(authorization(transport.calls[0])).toBe("Bearer dtn_key")
    expect(transport.calls[0]?.init?.method).toBe("GET")
  })

  test("a rejected key reads as broken, with a reason the row can show", async () => {
    const transport = respond({ ok: false, status: 401, body: "unauthorized" })

    const probe = await probeDiscoveredCredential(item(), { fetch: transport.stub })

    expect(probe).toMatchObject({ state: "broken", health: "auth_failed", reason: expect.any(String) })
  })

  test("an unreachable provider is unknown, never broken", async () => {
    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND app.daytona.io")
    }) as unknown as typeof fetch

    const probe = await probeDiscoveredCredential(item(), { fetch: offline })

    expect(probe.state).toBe("unknown")
    // No health at all: a failed request is the absence of a verdict, and a
    // health here would be saved onto the row as one.
    expect(probe).not.toHaveProperty("health")
  })

  test("a provider with no documented check says so rather than claiming a verdict", async () => {
    const transport = respond()

    const probe = await probeDiscoveredCredential(
      item({ provider_id: "modal", secret: JSON.stringify({ token_id: "ak-1", token_secret: "as-1" }) }),
      { fetch: transport.stub },
    )

    expect(probe).toMatchObject({ state: "unknown", reason: expect.any(String) })
    expect(probe).not.toHaveProperty("health")
    // Never guessed at an endpoint: a wrong probe that 404s would condemn a
    // working key.
    expect(transport.calls).toHaveLength(0)
  })

  test("a multi-field key is probed with every field it stored", async () => {
    const transport = respond()

    const probe = await probeDiscoveredCredential(
      item({
        provider_id: "vercel",
        secret: JSON.stringify({ access_token: "vc", team_id: "team_1", project_id: "prj_1" }),
      }),
      { fetch: transport.stub },
    )

    expect(probe).toEqual({ state: "working", health: "ok" })
    expect(transport.calls[0]?.url).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1")
    // The token is one of the three stored fields, and the two in the URL are
    // only proven because this header authenticated the read.
    expect(authorization(transport.calls[0])).toBe("Bearer vc")
  })
})
