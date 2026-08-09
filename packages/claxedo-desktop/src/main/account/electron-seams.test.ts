import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { credentialFile, loopbackListener, refreshExchange, tokenExchange } from "./electron-seams"

/**
 * The seams, against real sockets and a real filesystem.
 *
 * These are the parts the rest of the account code injects away, so they are
 * the parts nothing else exercises. The listener in particular has one property
 * worth proving on a real socket: it is bound to loopback, and it releases the
 * port when the attempt ends.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "claxedo-account-"))
  dirs.push(dir)
  return dir
}

describe("loopbackListener", () => {
  test("serves the callback path and returns the handler's disposition", async () => {
    const seen: string[] = []
    const server = await loopbackListener()((url) => {
      seen.push(url)
      return { status: 200, body: "Signed in." }
    })

    const response = await fetch(`http://127.0.0.1:${server.port}/claxedo/auth/callback?code=c&state=s`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("Signed in.")
    expect(seen[0]).toBe("/claxedo/auth/callback?code=c&state=s")
    await server.close()
  })

  test("relays a rejection's status rather than answering 200 regardless", async () => {
    const server = await loopbackListener()(() => ({ status: 400, body: "Sign-in failed." }))

    expect((await fetch(`http://127.0.0.1:${server.port}/x`)).status).toBe(400)
    await server.close()
  })

  test("releases the port on close", async () => {
    // A listener outliving its attempt is a port on the user's machine that
    // accepts authorization codes. Proven by rebinding it.
    const server = await loopbackListener()(() => ({ status: 200, body: "" }))
    const port = server.port

    await server.close()

    const second = await loopbackListener()(() => ({ status: 200, body: "" }))
    expect(typeof second.port).toBe("number")
    await second.close()
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow()
  }, 15_000)

  test("takes an OS-assigned port, not a fixed one", () => {
    // A fixed port is one another process can hold first, and RFC 8252 §7.3
    // expects an ephemeral one.
    expect(readFileSync(new URL("./electron-seams.ts", import.meta.url), "utf8")).toContain(
      'server.listen(0, "127.0.0.1"',
    )
  })
})

describe("credentialFile", () => {
  test("round-trips and clears", () => {
    const file = credentialFile(tempDir())

    expect(file.read()).toBeUndefined()
    file.write('{"a":1}')
    expect(file.read()).toBe('{"a":1}')
    file.clear()
    expect(file.read()).toBeUndefined()
  })

  test("clearing an absent file is not an error", () => {
    // Sign-out runs this whether or not anything was stored.
    expect(() => credentialFile(tempDir()).clear()).not.toThrow()
  })

  test("writes owner-only", () => {
    const dir = tempDir()
    credentialFile(dir).write("{}")
    const stored = join(dir, "account-credential.json")

    expect(readFileSync(new URL("./electron-seams.ts", import.meta.url), "utf8")).toContain(
      "writeFileSync(path, contents, { mode: 0o600 })",
    )
    if (process.platform === "win32") {
      // Windows applies the userData directory's inherited ACL; POSIX mode
      // bits are synthetic there and cannot represent that access control.
      expect(statSync(stored).isFile()).toBe(true)
    } else {
      expect(statSync(stored).mode & 0o777).toBe(0o600)
    }
  })
})

describe("tokenExchange", () => {
  test("bounds a token endpoint that never answers", async () => {
    const exchange = tokenExchange((async () => await new Promise<Response>(() => {})) as typeof fetch, 1)

    await expect(
      exchange({
        tokenUrl: "https://accounts.example/token",
        clientId: "desktop",
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1/callback",
      }),
    ).rejects.toThrow(/timed out/)
  })

  test("cancels an exchange even when the transport has not answered", async () => {
    const controller = new AbortController()
    const exchange = tokenExchange((async () => await new Promise<Response>(() => {})) as typeof fetch, 60_000)
    const pending = exchange({
      tokenUrl: "https://accounts.example/token",
      clientId: "desktop",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1/callback",
      signal: controller.signal,
    })

    controller.abort(new Error("sign-in cancelled"))

    await expect(pending).rejects.toThrow("sign-in cancelled")
  })

  test("sends the verifier and no client secret", async () => {
    // A native app cannot keep a secret; PKCE carries the proof instead. A
    // secret appearing here would mean one was shipped in the binary.
    let body = ""
    const exchange = tokenExchange((async (_url, init) => {
      body = String((init as RequestInit).body)
      return new Response(JSON.stringify({ access_token: "at", expires_in: 60 }), { status: 200 })
    }) as typeof fetch)

    await exchange({
      tokenUrl: "https://t.test",
      clientId: "c",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1:1/cb",
    })

    const params = new URLSearchParams(body)
    expect(params.get("grant_type")).toBe("authorization_code")
    expect(params.get("code_verifier")).toBe("verifier")
    expect(body).not.toContain("client_secret")
  })

  test("returns an absolute expiry, not the relative one", async () => {
    // Storing `expires_in` would make every reader remember when it was issued.
    const exchange = tokenExchange(
      (async () =>
        new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3_600 }), {
          status: 200,
        })) as typeof fetch,
    )

    const tokens = await exchange({
      tokenUrl: "https://t.test",
      clientId: "c",
      code: "x",
      codeVerifier: "v",
      redirectUri: "r",
    })

    expect(tokens.expiresAt).toBeGreaterThan(Date.now() / 1000 + 3_000)
    expect(tokens.refreshToken).toBe("rt")
  })

  test("fails loudly on a response with no access token", async () => {
    // An authorization server answering 200 with an error body would otherwise
    // produce a signed-in state holding `undefined`.
    const exchange = tokenExchange(
      (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 200 })) as typeof fetch,
    )

    await expect(
      exchange({ tokenUrl: "https://t.test", clientId: "c", code: "x", codeVerifier: "v", redirectUri: "r" }),
    ).rejects.toThrow(/no access token/)
  })

  test("fails on a non-2xx", async () => {
    const exchange = tokenExchange((async () => new Response("", { status: 400 })) as typeof fetch)

    await expect(
      exchange({ tokenUrl: "https://t.test", clientId: "c", code: "x", codeVerifier: "v", redirectUri: "r" }),
    ).rejects.toThrow(/failed: 400/)
  })
})

describe("refreshExchange", () => {
  test("reports a token endpoint timeout as unavailable", async () => {
    const exchange = refreshExchange((async () => await new Promise<Response>(() => {})) as typeof fetch, 1)

    await expect(
      exchange({ tokenUrl: "https://accounts.example/token", clientId: "desktop", refreshToken: "rt" }),
    ).resolves.toMatchObject({ ok: false, reason: "unavailable", detail: expect.stringContaining("timed out") })
  })

  const INPUT = { tokenUrl: "https://t.test", clientId: "c", refreshToken: "rt_1" }

  function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const bodies: string[] = []
    const exchange = refreshExchange((async (url, init) => {
      bodies.push(String((init as RequestInit).body))
      return await handler(String(url), init as RequestInit)
    }) as typeof fetch)
    return { exchange, bodies }
  }

  test("sends the refresh_token grant, and no secret", async () => {
    // The grant that did not exist. Without it `refresh` was API surface the
    // production wiring could never supply, so every session ended at the first
    // access-token expiry.
    const { exchange, bodies } = stub(
      () => new Response(JSON.stringify({ access_token: "at_2", expires_in: 3_600 }), { status: 200 }),
    )

    await exchange(INPUT)

    const params = new URLSearchParams(bodies[0])
    expect(params.get("grant_type")).toBe("refresh_token")
    expect(params.get("refresh_token")).toBe("rt_1")
    expect(params.get("client_id")).toBe("c")
    expect(bodies[0]).not.toContain("client_secret")
  })

  test("keeps the existing refresh token when the response does not rotate it", async () => {
    // A server that returns no `refresh_token` means "keep using the one you
    // have". Dropping it would quietly downgrade the session to unrenewable and
    // sign the user out one access token later, with nothing to explain why.
    const { exchange } = stub(
      () => new Response(JSON.stringify({ access_token: "at_2", expires_in: 3_600 }), { status: 200 }),
    )

    const outcome = await exchange(INPUT)

    expect(outcome).toMatchObject({ ok: true })
    expect(outcome.ok === true && outcome.tokens.refreshToken).toBe("rt_1")
    expect(outcome.ok === true && outcome.tokens.expiresAt).toBeGreaterThan(Date.now() / 1000 + 3_000)
  })

  test("takes a rotated refresh token over the old one", async () => {
    const { exchange } = stub(
      () => new Response(JSON.stringify({ access_token: "at_2", refresh_token: "rt_2" }), { status: 200 }),
    )

    const outcome = await exchange(INPUT)

    expect(outcome.ok === true && outcome.tokens.refreshToken).toBe("rt_2")
  })

  test("reports invalid_grant as revocation", async () => {
    // The one answer that means the credential is genuinely dead. RFC 6749 §5.2
    // spends this code on exactly that, and the caller signs the user out on it.
    const { exchange } = stub(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))

    expect(await exchange(INPUT)).toMatchObject({ ok: false, reason: "revoked" })
  })

  test("reports a 401 from the token endpoint as revocation", async () => {
    const { exchange } = stub(() => new Response("", { status: 401 }))

    expect(await exchange(INPUT)).toMatchObject({ ok: false, reason: "revoked" })
  })

  test("reports a network failure as unavailable, not revocation", async () => {
    // An offline laptop must not cost the user their session. This is the
    // difference between "reconnect and carry on" and "sign in again", and the
    // refresh token is gone by the time they notice.
    const { exchange } = stub(() => {
      throw new Error("getaddrinfo ENOTFOUND")
    })

    expect(await exchange(INPUT)).toMatchObject({ ok: false, reason: "unavailable" })
  })

  test("reports a server error as unavailable", async () => {
    const { exchange } = stub(() => new Response("", { status: 503 }))

    expect(await exchange(INPUT)).toMatchObject({ ok: false, reason: "unavailable" })
  })

  test("does not read a bare 400 as revocation", async () => {
    // A malformed request of OUR making also produces a 400. Signing the user
    // out over our own bug is the failure that cannot be walked back, so only
    // the server naming the grant dead earns that.
    const { exchange } = stub(() => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }))

    expect(await exchange(INPUT)).toMatchObject({ ok: false, reason: "unavailable" })
  })

  test("treats a 200 naming invalid_grant as revocation", async () => {
    // Some servers report a dead grant with a 200 and an error body.
    const { exchange } = stub(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 200 }))

    expect(await exchange(INPUT)).toMatchObject({ ok: false, reason: "revoked" })
  })

  test("does not invent a session from a 200 with no access token", async () => {
    const { exchange } = stub(() => new Response("not json", { status: 200 }))

    expect(await exchange(INPUT)).toMatchObject({ ok: false, reason: "unavailable" })
  })
})
