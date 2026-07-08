import { describe, expect, test, vi } from "vitest"
import {
  EGRESS_TARGET_HEADER,
  handleEgressRequest,
  mintEgressToken,
  verifyEgressToken,
} from "./cloudflare-egress"

const SECRET = "worker-egress-signing-secret"

async function token(overrides: { sandboxId?: string; hosts?: string[]; ttlSeconds?: number; now?: () => number } = {}) {
  return mintEgressToken({
    sandboxId: overrides.sandboxId ?? "claxedo-ws_1",
    hosts: overrides.hosts ?? ["api.notion.com"],
    signingSecret: SECRET,
    ...(overrides.ttlSeconds !== undefined ? { ttlSeconds: overrides.ttlSeconds } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  })
}

function egressRequest(tok: string, target: string, init: RequestInit = {}) {
  return new Request("https://worker.test/egress", {
    method: "GET",
    ...init,
    headers: { authorization: `Bearer ${tok}`, [EGRESS_TARGET_HEADER]: target, ...(init.headers as Record<string, string>) },
  })
}

describe("cloudflare egress broker", () => {
  test("mint/verify round-trips and binds sandbox + hosts", async () => {
    const claims = await verifyEgressToken(await token(), SECRET)
    expect(claims).toMatchObject({ sub: "claxedo-ws_1", hosts: ["api.notion.com"] })
  })

  test("verify rejects a tampered signature", async () => {
    const tok = await token()
    const tampered = tok.slice(0, -3) + "aaa"
    expect(await verifyEgressToken(tampered, SECRET)).toBeNull()
  })

  test("verify rejects a wrong signing secret and an expired token", async () => {
    expect(await verifyEgressToken(await token(), "other-secret")).toBeNull()
    const past = await token({ ttlSeconds: 60, now: () => 1_000_000 })
    expect(await verifyEgressToken(past, SECRET, () => 1_000_000 + 120_000)).toBeNull()
  })

  test("injects the brokered credential and never exposes it to the sandbox", async () => {
    const forwarded: Array<{ url: string; headers: Headers }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      forwarded.push({ url: String(url), headers: new Headers(init?.headers) })
      return new Response("ok", { headers: { "x-echo": "1" } })
    }) as unknown as typeof fetch

    const res = await handleEgressRequest(
      egressRequest(await token(), "https://api.notion.com/v1/users/me"),
      {
        signingSecret: SECRET,
        resolveSecret: (sandboxId, host) =>
          sandboxId === "claxedo-ws_1" && host === "api.notion.com"
            ? { header: "Authorization", value: "Bearer ntn-secret" }
            : undefined,
        fetchImpl,
      },
    )

    expect(res.status).toBe(200)
    expect(forwarded[0]!.url).toBe("https://api.notion.com/v1/users/me")
    // Credential injected on the upstream request…
    expect(forwarded[0]!.headers.get("authorization")).toBe("Bearer ntn-secret")
    // …and the sandbox-facing egress token/target headers are stripped.
    expect(forwarded[0]!.headers.get(EGRESS_TARGET_HEADER)).toBeNull()
  })

  test("rejects a host outside the token's allowlist", async () => {
    const res = await handleEgressRequest(
      egressRequest(await token({ hosts: ["api.notion.com"] }), "https://evil.example/steal"),
      { signingSecret: SECRET, resolveSecret: () => ({ header: "Authorization", value: "x" }) },
    )
    expect(res.status).toBe(403)
  })

  test("rejects when no credential is registered for the host", async () => {
    const res = await handleEgressRequest(
      egressRequest(await token(), "https://api.notion.com/x"),
      { signingSecret: SECRET, resolveSecret: () => undefined },
    )
    expect(res.status).toBe(403)
  })

  test("rejects missing/invalid token, missing target, and non-https target", async () => {
    const base = { signingSecret: SECRET, resolveSecret: () => ({ header: "H", value: "v" }) }
    expect(
      (await handleEgressRequest(new Request("https://worker.test/egress"), base)).status,
    ).toBe(401)
    expect(
      (await handleEgressRequest(
        new Request("https://worker.test/egress", { headers: { authorization: `Bearer ${await token()}` } }),
        base,
      )).status,
    ).toBe(400)
    expect(
      (await handleEgressRequest(egressRequest(await token({ hosts: ["x"] }), "http://x/y"), base)).status,
    ).toBe(400)
  })

  test("strips the injected header from the upstream response", async () => {
    const fetchImpl = (async () =>
      new Response("body", { headers: { Authorization: "Bearer leaked", "content-type": "text/plain" } })) as unknown as typeof fetch
    const res = await handleEgressRequest(
      egressRequest(await token(), "https://api.notion.com/x"),
      { signingSecret: SECRET, resolveSecret: () => ({ header: "Authorization", value: "Bearer ntn" }), fetchImpl },
    )
    expect(res.headers.get("authorization")).toBeNull()
    expect(res.headers.get("content-type")).toBe("text/plain")
  })
})
