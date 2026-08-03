import { describe, expect, test } from "vitest"
import { CredentialVerificationError } from "./verify"
import { verifySandboxDriverAuth } from "./sandbox-verify"

/**
 * One stub for every provider probe. Recording the request is half the point:
 * a probe that bills, mutates, or hits an undocumented route is a defect even
 * when its verdict happens to be right.
 */
function transport(input: { ok?: boolean; status?: number; body?: string } = {}) {
  const calls: Array<{
    url: string
    method?: string
    headers: Record<string, string>
    body?: string
  }> = []
  const stub = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(url),
      ...(init?.method ? { method: init.method } : {}),
      headers,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    })
    return {
      ok: input.ok ?? true,
      status: input.status ?? (input.ok === false ? 400 : 200),
      text: async () => input.body ?? "",
      body: undefined,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { stub, calls, first: () => calls[0]! }
}

const offline = (async () => {
  throw new Error("getaddrinfo ENOTFOUND provider")
}) as unknown as typeof fetch

describe("daytona", () => {
  // https://www.daytona.io/docs/en/api-keys/ — "Get current API key's details",
  // authenticated with the API key itself. O(1), reads nothing but the key.
  test("an API key verifies against the documented key-introspection route", async () => {
    const transports = transport()

    const health = await verifySandboxDriverAuth("daytona", { api_key: "dtn_key" }, { fetch: transports.stub })

    expect(health).toBe("ok")
    expect(transports.first().url).toBe("https://app.daytona.io/api/api-keys/current")
    expect(transports.first().method).toBe("GET")
    expect(transports.first().headers.Authorization).toBe("Bearer dtn_key")
    expect(transports.first().body).toBeUndefined()
  })

  test("a rejected Daytona key is auth_failed, not an error", async () => {
    const transports = transport({ ok: false, status: 401, body: "unauthorized" })

    await expect(
      verifySandboxDriverAuth("daytona", { api_key: "dtn_revoked" }, { fetch: transports.stub }),
    ).resolves.toBe("auth_failed")
  })

  test("a network failure is inconclusive, never a verdict against the key", async () => {
    await expect(
      verifySandboxDriverAuth("daytona", { api_key: "dtn_key" }, { fetch: offline }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a key pasted with surrounding whitespace is sent bare", async () => {
    const transports = transport()

    await verifySandboxDriverAuth("daytona", { api_key: "  dtn_key\n" }, { fetch: transports.stub })

    expect(transports.first().headers.Authorization).toBe("Bearer dtn_key")
  })
})

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

    expect(health).toBe("ok")
    expect(transports.first().url).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1")
    expect(transports.first().method).toBe("GET")
    expect(transports.first().headers.Authorization).toBe("Bearer vc_token")
  })

  test("a rejected Vercel token is auth_failed", async () => {
    const transports = transport({ ok: false, status: 403, body: "forbidden" })

    await expect(
      verifySandboxDriverAuth(
        "vercel",
        { access_token: "vc_token", team_id: "team_1", project_id: "prj_1" },
        { fetch: transports.stub },
      ),
    ).resolves.toBe("auth_failed")
  })

  /**
   * A 404 means the token authenticated but the saved team/project pair names
   * nothing it can reach. The credential set cannot launch a sandbox, so this
   * is a verdict — not the "couldn't check" state a network failure earns.
   */
  test("a project the token cannot see is a verdict, not an inconclusive", async () => {
    const transports = transport({ ok: false, status: 404, body: "not found" })

    await expect(
      verifySandboxDriverAuth(
        "vercel",
        { access_token: "vc_token", team_id: "team_1", project_id: "prj_missing" },
        { fetch: transports.stub },
      ),
    ).resolves.toBe("auth_failed")
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

    expect(health).toBe("ok")
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
    ).resolves.toBe("auth_failed")
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
    ).resolves.toBe("ok")
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

describe("box", () => {
  // https://docs.ascii.dev/box/api/reference/account/get-current-box-user.md
  test("an API key verifies against the documented account read", async () => {
    const transports = transport({ body: JSON.stringify({ ok: true, user: { login: "octocat" } }) })

    const health = await verifySandboxDriverAuth("box", { api_key: "box_key" }, { fetch: transports.stub })

    expect(health).toBe("ok")
    expect(transports.first().url).toBe("https://ascii.dev/api/box/v1/me")
    expect(transports.first().method).toBe("GET")
    expect(transports.first().headers.Authorization).toBe("Bearer box_key")
    expect(transports.first().body).toBeUndefined()
  })

  test("a rejected Box key is auth_failed", async () => {
    const transports = transport({
      ok: false,
      status: 401,
      body: JSON.stringify({ ok: false, code: "unauthorized", message: "Missing or invalid bearer token" }),
    })

    await expect(
      verifySandboxDriverAuth("box", { api_key: "box_revoked" }, { fetch: transports.stub }),
    ).resolves.toBe("auth_failed")
  })

  test("a network failure is inconclusive, never a verdict against the key", async () => {
    await expect(
      verifySandboxDriverAuth("box", { api_key: "box_key" }, { fetch: offline }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a key pasted with surrounding whitespace is sent bare", async () => {
    const transports = transport({ body: JSON.stringify({ ok: true }) })

    await verifySandboxDriverAuth("box", { api_key: " box_key\n" }, { fetch: transports.stub })

    expect(transports.first().headers.Authorization).toBe("Bearer box_key")
  })
})

describe("exe.dev", () => {
  // https://exe.dev/docs/https-api.md — `whoami` is in the default token `cmds`
  // allowlist and is the docs' own example call.
  test("a token verifies against the documented whoami command", async () => {
    const transports = transport({ body: JSON.stringify({ ok: true }) })

    const health = await verifySandboxDriverAuth("exe", { api_token: "exe1.token" }, { fetch: transports.stub })

    expect(health).toBe("ok")
    expect(transports.first().url).toBe("https://exe.dev/exec")
    expect(transports.first().method).toBe("POST")
    expect(transports.first().headers.Authorization).toBe("Bearer exe1.token")
    // The command must be the read-only one, never anything that provisions.
    expect(transports.first().body).toBe("whoami")
  })

  test("a rejected exe.dev token is auth_failed", async () => {
    const transports = transport({ ok: false, status: 401, body: "invalid token" })

    await expect(
      verifySandboxDriverAuth("exe", { api_token: "exe1.revoked" }, { fetch: transports.stub }),
    ).resolves.toBe("auth_failed")
  })

  /**
   * exe.dev tokens carry a signed `cmds` allowlist, and 403 means the token is
   * VALID but not permitted to run this command — documented separately from
   * 401 "invalid token". Mapping it to auth_failed would call a working
   * narrowly-scoped token broken.
   */
  test("a token scoped away from whoami is inconclusive, not a rejection", async () => {
    const transports = transport({ ok: false, status: 403, body: "command not permitted" })

    await expect(
      verifySandboxDriverAuth("exe", { api_token: "exe1.scoped" }, { fetch: transports.stub }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a network failure is inconclusive, never a verdict against the key", async () => {
    await expect(
      verifySandboxDriverAuth("exe", { api_token: "exe1.token" }, { fetch: offline }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a token pasted with surrounding whitespace is sent bare", async () => {
    const transports = transport({ body: JSON.stringify({ ok: true }) })

    await verifySandboxDriverAuth("exe", { api_token: " exe1.token\n" }, { fetch: transports.stub })

    expect(transports.first().headers.Authorization).toBe("Bearer exe1.token")
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
      verifySandboxDriverAuth("daytona", { api_key: "   " }, { fetch: transports.stub }),
    ).rejects.toThrow(/unsupported shape/)
    expect(transports.calls).toHaveLength(0)
  })
})

describe("shared status mapping", () => {
  test("a rate-capped provider still authenticated", async () => {
    const transports = transport({ ok: false, status: 429, body: "too many requests" })

    await expect(
      verifySandboxDriverAuth("daytona", { api_key: "dtn_key" }, { fetch: transports.stub }),
    ).resolves.toBe("rate_capped")
  })

  test("a provider reporting no billing is distinguished from a bad key", async () => {
    const transports = transport({ ok: false, status: 402, body: "payment required" })

    await expect(
      verifySandboxDriverAuth("box", { api_key: "box_key" }, { fetch: transports.stub }),
    ).resolves.toBe("no_billing")
  })

  test("an unmapped provider status is inconclusive rather than a guess", async () => {
    const transports = transport({ ok: false, status: 503, body: "service unavailable" })

    await expect(
      verifySandboxDriverAuth("daytona", { api_key: "dtn_key" }, { fetch: transports.stub }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })
})
