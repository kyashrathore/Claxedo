import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { credentialFile, loopbackListener, tokenExchange } from "./electron-seams"

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
    expect(readFileSync(new URL("./electron-seams.ts", import.meta.url), "utf8")).toContain('server.listen(0, "127.0.0.1"')
  })
})

describe("credentialFile", () => {
  test("round-trips and clears", () => {
    const file = credentialFile(tempDir())

    expect(file.read()).toBeUndefined()
    file.write("{\"a\":1}")
    expect(file.read()).toBe("{\"a\":1}")
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

    expect(statSync(join(dir, "account-credential.json")).mode & 0o777).toBe(0o600)
  })
})

describe("tokenExchange", () => {
  test("sends the verifier and no client secret", async () => {
    // A native app cannot keep a secret; PKCE carries the proof instead. A
    // secret appearing here would mean one was shipped in the binary.
    let body = ""
    const exchange = tokenExchange((async (_url, init) => {
      body = String((init as RequestInit).body)
      return new Response(JSON.stringify({ access_token: "at", expires_in: 60 }), { status: 200 })
    }) as typeof fetch)

    await exchange({ tokenUrl: "https://t.test", clientId: "c", code: "code", codeVerifier: "verifier", redirectUri: "http://127.0.0.1:1/cb" })

    const params = new URLSearchParams(body)
    expect(params.get("grant_type")).toBe("authorization_code")
    expect(params.get("code_verifier")).toBe("verifier")
    expect(body).not.toContain("client_secret")
  })

  test("returns an absolute expiry, not the relative one", async () => {
    // Storing `expires_in` would make every reader remember when it was issued.
    const exchange = tokenExchange((async () =>
      new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3_600 }), { status: 200 })) as typeof fetch)

    const tokens = await exchange({ tokenUrl: "https://t.test", clientId: "c", code: "x", codeVerifier: "v", redirectUri: "r" })

    expect(tokens.expiresAt).toBeGreaterThan(Date.now() / 1000 + 3_000)
    expect(tokens.refreshToken).toBe("rt")
  })

  test("fails loudly on a response with no access token", async () => {
    // An authorization server answering 200 with an error body would otherwise
    // produce a signed-in state holding `undefined`.
    const exchange = tokenExchange((async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 200 })) as typeof fetch)

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
