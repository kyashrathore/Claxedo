import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { request } from "node:https"
import type { AddressInfo } from "node:net"

import { startDesktopNativeAuthFixture, type DesktopNativeAuthFixture } from "../helpers/desktop-native-auth-fixture"

type Response = { status: number; headers: import("node:http").IncomingHttpHeaders; body: string }

async function httpsRequest(input: {
  url: string
  ca: Buffer
  method?: string
  body?: URLSearchParams
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = input.body?.toString()
    const outgoing = request(
      input.url,
      {
        method: input.method ?? "GET",
        ca: input.ca,
        headers: body
          ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) }
          : undefined,
      },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        incoming.once("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      },
    )
    outgoing.once("error", reject)
    outgoing.end(body)
  })
}

describe("desktop native auth HTTPS fixture", () => {
  let fixture: DesktopNativeAuthFixture | undefined
  let closeUpstream: (() => Promise<void>) | undefined

  afterEach(async () => {
    await fixture?.close()
    fixture = undefined
    await closeUpstream?.()
    closeUpstream = undefined
  })

  test("serves an origin-bound descriptor and enforces S256, refresh rotation, revoke, and proxying", async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ path: request.url }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    closeUpstream = () => new Promise<void>((resolve) => upstream.close(() => resolve()))
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    fixture = await startDesktopNativeAuthFixture({
      upstreamOrigin,
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
    })
    const ca = await readFile(fixture.caPath)

    const descriptorResponse = await httpsRequest({
      url: `${fixture.origin}/api/claxedo/auth/descriptor`,
      ca,
    })
    expect(descriptorResponse.status).toBe(200)
    expect(JSON.parse(descriptorResponse.body)).toMatchObject({
      adapter: "better-auth",
      issuer: `${fixture.origin}/api/auth`,
      native: {
        desktop: {
          clientId: "claxedo-desktop-e2e",
          resource: `${fixture.origin}/control-plane`,
          tokenEndpointOrigin: fixture.origin,
          controlPlaneOrigin: fixture.origin,
        },
      },
    })

    const verifier = "desktop-e2e-verifier-with-enough-entropy-0123456789"
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const callback = "http://127.0.0.1:41839/callback"
    const authorize = new URL(`${fixture.origin}/api/auth/oauth2/authorize`)
    authorize.searchParams.set("client_id", "claxedo-desktop-e2e")
    authorize.searchParams.set("resource", `${fixture.origin}/control-plane`)
    authorize.searchParams.set("redirect_uri", callback)
    authorize.searchParams.set("state", "fixture-state")
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("code_challenge", challenge)
    const authorizeResponse = await httpsRequest({ url: authorize.toString(), ca })
    expect(authorizeResponse.status).toBe(302)
    const redirect = new URL(authorizeResponse.headers.location!)
    expect(redirect.origin).toBe("http://127.0.0.1:41839")
    expect(redirect.searchParams.get("state")).toBe("fixture-state")

    const invalidExchange = await httpsRequest({
      url: `${fixture.origin}/api/auth/oauth2/token`,
      ca,
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "claxedo-desktop-e2e",
        resource: `${fixture.origin}/control-plane`,
        redirect_uri: callback,
        code: redirect.searchParams.get("code")!,
        code_verifier: "wrong-verifier",
      }),
    })
    expect(invalidExchange.status).toBe(400)

    const exchange = await httpsRequest({
      url: `${fixture.origin}/api/auth/oauth2/token`,
      ca,
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "claxedo-desktop-e2e",
        resource: `${fixture.origin}/control-plane`,
        redirect_uri: callback,
        code: redirect.searchParams.get("code")!,
        code_verifier: verifier,
      }),
    })
    expect(exchange.status).toBe(200)
    expect(JSON.parse(exchange.body)).toMatchObject({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      token_type: "Bearer",
    })

    const refresh = await httpsRequest({
      url: `${fixture.origin}/api/auth/oauth2/token`,
      ca,
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "claxedo-desktop-e2e",
        resource: `${fixture.origin}/control-plane`,
        refresh_token: "fixture-refresh",
      }),
    })
    expect(refresh.status).toBe(200)
    expect(JSON.parse(refresh.body).refresh_token).toBe("desktop-e2e-refresh-1")
    expect(fixture.refreshes()).toBe(1)

    const revoke = await httpsRequest({
      url: `${fixture.origin}/api/auth/oauth2/revoke`,
      ca,
      method: "POST",
      body: new URLSearchParams({
        client_id: "claxedo-desktop-e2e",
        token: "desktop-e2e-refresh-1",
        token_type_hint: "refresh_token",
      }),
    })
    expect(revoke.status).toBe(200)
    expect(fixture.revokeRequests).toHaveLength(1)

    const proxied = await httpsRequest({ url: `${fixture.origin}/workspace?id=one`, ca })
    expect(proxied.status).toBe(200)
    expect(JSON.parse(proxied.body)).toEqual({ path: "/workspace?id=one" })
  })
})
