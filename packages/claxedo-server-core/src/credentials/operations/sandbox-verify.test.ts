import { describe, expect, test } from "vitest"
import { CredentialVerificationError } from "./verify"
import { verifySandboxDriverAuth } from "./sandbox-verify"

/**
 * One stub for every provider probe, with workerd's redirect rule: a mode
 * other than "follow" or "manual" is a TypeError before any request leaves,
 * which the probe reports as the provider being unreachable. Recording the
 * request is the other half of the point: a probe that bills, mutates, or hits
 * an undocumented route is a defect even when its verdict happens to be right.
 */
function transport(input: { ok?: boolean; status?: number; body?: string; headers?: Record<string, string> } = {}) {
  const calls: Array<{
    url: string
    method?: string
    headers: Record<string, string>
    body?: string
  }> = []
  const stub = (async (url: string | URL, init?: RequestInit) => {
    if (init?.redirect !== "follow" && init?.redirect !== "manual") {
      throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual" ("${init?.redirect}" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code).`)
    }
    expect(init.redirect).toBe("manual")
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(url),
      ...(init?.method ? { method: init.method } : {}),
      headers,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    })
    const body = input.body ?? ""
    return new Response(body, {
      status: input.status ?? (input.ok === false ? 400 : 200),
      headers: { ...(body.startsWith("{") ? { "content-type": "application/json" } : {}), ...input.headers },
    })
  }) as unknown as typeof fetch
  return { stub, calls, first: () => calls[0] }
}

/** What an edge answers a request it challenges, or a mistyped URL's site answers a route it lacks: a page, not the provider API's error. */
const HTML_PAGE = { body: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>", headers: { "content-type": "text/html; charset=UTF-8" } }

const offline = (async () => {
  throw new Error("getaddrinfo ENOTFOUND provider")
}) as unknown as typeof fetch

describe("vercel", () => {
  /**
   * The catalog requires all three fields, so verifying only the token would
   * let a wrong team/project through to first-provision. `GET /v9/projects/:id`
   * proves all three in one documented read:
   * https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name
   */
  test("the token, team, and project are proven by one documented project read", async () => {
    const transports = transport()

    const health = await verifySandboxDriverAuth(
      "vercel",
      { access_token: "vc_token", team_id: "team_1", project_id: "prj_1" },
      { fetch: transports.stub },
    )

    expect(health).toEqual({ health: "ok" })
    expect(transports.first().url).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1")
    expect(transports.first().method).toBe("GET")
    expect(transports.first().headers.Authorization).toBe("Bearer vc_token")
  })

  test("a rejected Vercel token is auth_failed", async () => {
    const transports = transport({ ok: false, status: 403, body: JSON.stringify({ error: { code: "forbidden", message: "Not authorized" } }) })

    await expect(
      verifySandboxDriverAuth(
        "vercel",
        { access_token: "vc_token", team_id: "team_1", project_id: "prj_1" },
        { fetch: transports.stub },
      ),
    ).resolves.toMatchObject({ health: "auth_failed" })
  })

  /**
   * A 404 means the token authenticated but the saved team/project pair names
   * nothing it can reach. The credential set cannot launch a sandbox, so this
   * is a verdict — not the "couldn't check" state a network failure earns.
   */
  test("a project the token cannot see is a verdict, not an inconclusive", async () => {
    const transports = transport({ ok: false, status: 404, body: JSON.stringify({ error: { code: "not_found", message: "Project not found" } }) })

    await expect(
      verifySandboxDriverAuth(
        "vercel",
        { access_token: "vc_token", team_id: "team_1", project_id: "prj_missing" },
        { fetch: transports.stub },
      ),
    ).resolves.toMatchObject({ health: "auth_failed" })
  })

  test("a network failure is inconclusive, never a verdict against the key", async () => {
    await expect(
      verifySandboxDriverAuth(
        "vercel",
        { access_token: "vc_token", team_id: "team_1", project_id: "prj_1" },
        { fetch: offline },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("values pasted with surrounding whitespace are sent bare", async () => {
    const transports = transport()

    await verifySandboxDriverAuth(
      "vercel",
      { access_token: " vc_token\n", team_id: " team_1 ", project_id: "\tprj_1 " },
      { fetch: transports.stub },
    )

    expect(transports.first().headers.Authorization).toBe("Bearer vc_token")
    expect(transports.first().url).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1")
  })
})

describe("cloudflare", () => {
  test.each(["http://worker.test", "http://localhost:8787", "https://user:password@worker.test", "https://worker.test/?query", "https://worker.test/#fragment"])("does not send a token to rejected endpoint %s", async (worker_url) => {
    const transports = transport()
    await expect(verifySandboxDriverAuth("cloudflare", { api_token: "synthetic-token", worker_url }, { fetch: transports.stub })).rejects.toBeInstanceOf(CredentialVerificationError)
    expect(transports.calls).toEqual([])
  })

  test.each([301, 302, 307, 308])("refuses redirect status %s instead of accepting another endpoint", async (status) => {
    const transports = transport({ status, ok: false })
    await expect(verifySandboxDriverAuth("cloudflare", { api_token: "synthetic-token", worker_url: "https://worker.test" }, { fetch: transports.stub })).rejects.toThrow(/redirects/)
    expect(transports.calls).toHaveLength(1)
  })
  /**
   * The Cloudflare credential is NOT an account API token — it is the user's
   * own Worker's `API_TOKEN` secret (drivers/cloudflare.ts:38), so
   * `api.cloudflare.com/client/v4/user/tokens/verify` would probe a credential
   * this driver deliberately does not hold. The pair is only meaningful to the
   * deployed Worker, whose `GET /sandboxes` sits behind the same admin gate as
   * every mutating action and creates nothing.
   */
  test("the pair is proven against the user's own Worker, not the Cloudflare account API", async () => {
    const transports = transport()

    const health = await verifySandboxDriverAuth(
      "cloudflare",
      { api_token: "worker_secret", worker_url: "https://sbx.example.com" },
      { fetch: transports.stub },
    )

    expect(health).toEqual({ health: "ok" })
    expect(transports.first().url).toBe("https://sbx.example.com/sandboxes")
    expect(transports.first().method).toBe("GET")
    expect(transports.first().headers.Authorization).toBe("Bearer worker_secret")
  })

  test("a trailing slash on the Worker URL does not double up the path", async () => {
    const transports = transport()

    await verifySandboxDriverAuth(
      "cloudflare",
      { api_token: "worker_secret", worker_url: "https://sbx.example.com/" },
      { fetch: transports.stub },
    )

    expect(transports.first().url).toBe("https://sbx.example.com/sandboxes")
  })

  test("a wrong Worker token is auth_failed", async () => {
    const transports = transport({ ok: false, status: 403, body: JSON.stringify({ error: "forbidden" }) })

    await expect(
      verifySandboxDriverAuth(
        "cloudflare",
        { api_token: "wrong_secret", worker_url: "https://sbx.example.com" },
        { fetch: transports.stub },
      ),
    ).resolves.toMatchObject({ health: "auth_failed" })
  })

  /**
   * The Worker answers 501 when no R2 bucket is bound. That reply is produced
   * AFTER the admin gate (cloudflare-worker/src/index.ts:335 gates, :349
   * handles), so reaching it proves the token passed. Calling it broken would
   * reject a working pair over an unrelated, optional binding.
   */
  test("a Worker with no registry bucket still proves the token", async () => {
    const transports = transport({
      ok: false,
      status: 501,
      body: JSON.stringify({ supported: false, error: "sandbox registry not configured (bind BACKUP_BUCKET)" }),
    })

    await expect(
      verifySandboxDriverAuth(
        "cloudflare",
        { api_token: "worker_secret", worker_url: "https://sbx.example.com" },
        { fetch: transports.stub },
      ),
    ).resolves.toMatchObject({ health: "ok" })
  })

  test("an unreachable Worker is inconclusive, never a verdict against the key", async () => {
    await expect(
      verifySandboxDriverAuth(
        "cloudflare",
        { api_token: "worker_secret", worker_url: "https://sbx.example.com" },
        { fetch: offline },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a Worker URL that is not a URL is inconclusive rather than a bad request", async () => {
    const transports = transport()

    await expect(
      verifySandboxDriverAuth(
        "cloudflare",
        { api_token: "worker_secret", worker_url: "not a url" },
        { fetch: transports.stub },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })
})

describe("boat", () => {
  // https://docs.boat.dev/api/reference/account/get-current-boat-user.md
  test("an API key verifies against the documented account read", async () => {
    const transports = transport({ body: JSON.stringify({ ok: true, user: { login: "octocat" } }) })

    const health = await verifySandboxDriverAuth("boat", { api_key: "boat_key" }, { fetch: transports.stub })

    expect(health).toEqual({ health: "ok" })
    expect(transports.first().url).toBe("https://boat.dev/api/v1/me")
    expect(transports.first().method).toBe("GET")
    expect(transports.first().headers.Authorization).toBe("Bearer boat_key")
    expect(transports.first().body).toBeUndefined()
  })

  test("a rejected Boat key is auth_failed", async () => {
    const transports = transport({
      ok: false,
      status: 401,
      body: JSON.stringify({ ok: false, code: "unauthorized", message: "Missing or invalid bearer token" }),
    })

    await expect(
      verifySandboxDriverAuth("boat", { api_key: "boat_revoked" }, { fetch: transports.stub }),
    ).resolves.toMatchObject({ health: "auth_failed" })
  })

  test("a network failure is inconclusive, never a verdict against the key", async () => {
    await expect(
      verifySandboxDriverAuth("boat", { api_key: "boat_key" }, { fetch: offline }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a key pasted with surrounding whitespace is sent bare", async () => {
    const transports = transport({ body: JSON.stringify({ ok: true }) })

    await verifySandboxDriverAuth("boat", { api_key: " boat_key\n" }, { fetch: transports.stub })

    expect(transports.first().headers.Authorization).toBe("Bearer boat_key")
  })
})

describe("providers with no documented probe", () => {
  /**
   * Modal's control plane is gRPC over HTTP/2 (`nice-grpc` against
   * api.modal.com:443) with no REST surface — `modal token set --verify` runs
   * an RPC, not a request `fetch` can make. Rather than invent an endpoint or
   * pull a gRPC client into the credential path, this reports honestly and the
   * caller renders "can't check", exactly as an unsupported AI provider does.
   */
  test("Modal is unverifiable rather than probed against an invented endpoint", async () => {
    const transports = transport()

    await expect(
      verifySandboxDriverAuth(
        "modal",
        { token_id: "ak-1", token_secret: "as-1" },
        { fetch: transports.stub },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
    expect(transports.calls).toHaveLength(0)
  })

  test("Docker has no remote credential to check", async () => {
    const transports = transport()

    await expect(
      verifySandboxDriverAuth("docker", { image: "ghcr.io/example:1" }, { fetch: transports.stub }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
    expect(transports.calls).toHaveLength(0)
  })

  test("an unverifiable provider says so, distinctly from a failed request", async () => {
    await expect(
      verifySandboxDriverAuth("modal", { token_id: "ak-1", token_secret: "as-1" }, {}),
    ).rejects.toThrow(/does not support verification/)
  })
})

describe("incomplete credentials", () => {
  test("a missing field is unreadable rather than a verdict against what was given", async () => {
    const transports = transport()

    await expect(
      verifySandboxDriverAuth("vercel", { access_token: "vc_token" }, { fetch: transports.stub }),
    ).rejects.toThrow(/unsupported shape/)
    expect(transports.calls).toHaveLength(0)
  })

  test("a blank value is treated as missing, not sent as an empty credential", async () => {
    const transports = transport()

    await expect(
      verifySandboxDriverAuth("boat", { api_key: "   " }, { fetch: transports.stub }),
    ).rejects.toThrow(/unsupported shape/)
    expect(transports.calls).toHaveLength(0)
  })
})

describe("shared status mapping", () => {
  test("a rate-capped provider still authenticated", async () => {
    const transports = transport({ ok: false, status: 429, body: "too many requests" })

    await expect(
      verifySandboxDriverAuth("boat", { api_key: "boat_key" }, { fetch: transports.stub }),
    ).resolves.toEqual({ health: "rate_capped", evidence: { status: 429 } })
  })

  test("a provider reporting no billing is distinguished from a bad key", async () => {
    const transports = transport({ ok: false, status: 402, body: JSON.stringify({ error: "payment_required" }) })

    await expect(
      verifySandboxDriverAuth("boat", { api_key: "boat_key" }, { fetch: transports.stub }),
    ).resolves.toEqual({ health: "no_billing", evidence: { status: 402, type: "payment_required" } })
  })

  /**
   * Only the provider API's own answer is a verdict. An edge challenging the
   * request, or a mistyped Worker URL reaching some site's own error page,
   * answers with HTML; reading that as a refusal condemned a working key, and
   * reading a page's 501 as the Worker's "no bucket bound" would prove a key
   * nothing had checked.
   */
  test("a page rather than the provider's error is inconclusive, whichever status it carries", async () => {
    for (const status of [401, 403, 404, 500]) {
      await expect(
        verifySandboxDriverAuth("boat", { api_key: "boat_key" }, { fetch: transport({ status, ...HTML_PAGE }).stub }),
      ).rejects.toMatchObject({ code: "credential_verification_failed", message: expect.stringMatching(new RegExp(`${status} with text/html`)) })
    }
  })

  test("a 501 page from something that is not the Worker proves nothing", async () => {
    await expect(
      verifySandboxDriverAuth(
        "cloudflare",
        { api_token: "worker_secret", worker_url: "https://not-a-worker.example.com" },
        { fetch: transport({ status: 501, ...HTML_PAGE }).stub },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a refusal carries the provider's status and error code, never its message", async () => {
    const transports = transport({
      status: 401,
      body: JSON.stringify({ ok: false, code: "unauthorized", message: "Missing or invalid bearer token boat_key" }),
    })

    await expect(
      verifySandboxDriverAuth("boat", { api_key: "boat_key" }, { fetch: transports.stub }),
    ).resolves.toEqual({ health: "auth_failed", evidence: { status: 401, type: "unauthorized" } })
  })

  test("an unmapped provider status is inconclusive rather than a guess", async () => {
    const transports = transport({ ok: false, status: 503, body: "service unavailable" })

    await expect(
      verifySandboxDriverAuth("boat", { api_key: "boat_key" }, { fetch: transports.stub }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })
})
