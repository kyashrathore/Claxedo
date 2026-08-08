import { describe, expect, test } from "vitest"
import { probeDiscoveredCredential } from "@claxedo/server-core/credentials/operations/probe"
import type { LocalCredentialItem } from "@claxedo/server-core/credentials/operations/sync"

/**
 * `probeDiscoveredCredential` is provider-agnostic — it routes through
 * `verifyCredential` and maps whatever comes back. These pin that a sandbox
 * provider key discovered on this machine now earns the same live verdict an
 * AI credential does, rather than the flat "can't check this provider" every
 * sandbox row used to get.
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

describe("discovered sandbox provider keys get live verdicts", () => {
  test("a working key reads as working, not as an uncheckable provider", async () => {
    const transport = respond()

    const probe = await probeDiscoveredCredential(item(), { fetch: transport.stub })

    expect(probe).toEqual({ state: "working" })
    expect(transport.calls[0]).toBe("https://app.daytona.io/api/api-keys/current")
  })

  test("a rejected key reads as broken with a sentence, not a code", async () => {
    const transport = respond({ ok: false, status: 401, body: "unauthorized" })

    const probe = await probeDiscoveredCredential(item(), { fetch: transport.stub })

    expect(probe).toEqual({ state: "broken", reason: "The provider rejected this credential." })
  })

  test("an unreachable provider is unknown, never broken", async () => {
    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND app.daytona.io")
    }) as unknown as typeof fetch

    const probe = await probeDiscoveredCredential(item(), { fetch: offline })

    expect(probe.state).toBe("unknown")
  })

  test("a provider with no documented check says so rather than claiming a verdict", async () => {
    const transport = respond()

    const probe = await probeDiscoveredCredential(
      item({ provider_id: "modal", secret: JSON.stringify({ token_id: "ak-1", token_secret: "as-1" }) }),
      { fetch: transport.stub },
    )

    expect(probe).toEqual({
      state: "unknown",
      reason: "Claxedo can't check this provider yet — it will be used as-is.",
    })
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

    expect(probe).toEqual({ state: "working" })
    expect(transport.calls[0]).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1")
  })
})
