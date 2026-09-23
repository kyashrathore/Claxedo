import { createServer } from "node:https"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"

const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUGX7RhTm4aITiZb3/kueVp1R85o8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgyODAzNTc0OFoXDTM2MDgy
NTAzNTc0OFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAr7qh9zuPB6UQnJl2gJGTjIPp+HHRaAJiHkAL2pGNE+Lm
r9fGwrD+7sxya0uNPV9wniEnyFTbnpbI2jgGGpQDGoVXE3+CROOUv2YY/HbCIZcL
Cih/9o48ie6+UwPOv88kb1CQGMgNFc/6toP+RC8G3cED9h8hZ2yvluSukYcpTnlT
yz72qNm2rq7AFT7iFaRyDN+VHjvXHHO2NGQFUl5rAj1j1XU+yHQf1VGuRYodNXcs
GiFdmFUInu2D9X7AXjLMXNhuPbf8WbASLka6+ma/Jz3J731dq8z/wNV0x8ghw3vr
hlLVmRBqz6ibLLKoPQZO+pLtEE9GPnnyHXI85EDTAQIDAQABo28wbTAdBgNVHQ4E
FgQUqlpSgejZymy3slKkctnzLPz/AwQwHwYDVR0jBBgwFoAUqlpSgejZymy3slKk
ctnzLPz/AwQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAGrTQTj6sYElBz+PKL2FjK7B67bvV9le
MDkKAf2RUZCPWjOgxNXDGyVa7wWXhhFILAmLmMU2TI1vYj4+bs+78RdeFC+oZOOb
GnLOGNu93vYlZXjc46hipnLyNhueKP+CrMOY6qWLvRfxSAz6rf4Q2woMVaU8bQf9
AY7eFiUPCtfVGKJGbxnF6DMbzW7IPaWXt6szdOQR8chy17bl+aOh7yQTMaGwbIcH
54cbxQyOuRdd2/LOOXdYbN+bgse6rNlvdfJx8l8RZvc7nHSnxNkXDHuY7b0qSv2/
0R5qd9MWliDh0LQpYCLMBJ1d+pcSrU9TtY8rchqUJH5Ue8IDDRjlekU=
-----END CERTIFICATE-----`

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCvuqH3O48HpRCc
mXaAkZOMg+n4cdFoAmIeQAvakY0T4uav18bCsP7uzHJrS409X3CeISfIVNuelsja
OAYalAMahVcTf4JE45S/Zhj8dsIhlwsKKH/2jjyJ7r5TA86/zyRvUJAYyA0Vz/q2
g/5ELwbdwQP2HyFnbK+W5K6RhylOeVPLPvao2baursAVPuIVpHIM35UeO9ccc7Y0
ZAVSXmsCPWPVdT7IdB/VUa5Fih01dywaIV2YVQie7YP1fsBeMsxc2G49t/xZsBIu
Rrr6Zr8nPcnvfV2rzP/A1XTHyCHDe+uGUtWZEGrPqJsssqg9Bk76ku0QT0Y+efId
cjzkQNMBAgMBAAECggEASHvyn/CUtEINYpLYcvrZQi4NXbnQ9xZ4k2K2oP7FkuzW
W7Tk2ty4Ixb4oTJGPYj3AnrJlpQODNHEYmKWffMMfq1+d9/yA2leKz65UrXHqKRN
XPDMq44LAZgVMFfTOYH/VN0FuvsVjqg9kXhLcqN1MRYTBLvdgvQtT0/fg86dJq0s
OdoziEQBxC2jwaN2XmbKscrvpxKWmOJuNl//lqqS3LNyTNaVOIbCBFxxsrBFEDe8
IGhzr4lPOW6Ie5sUKLaI0XnjroRaLI3Haywd+95RL2b3UBBQzZ9QdNXZdh6TnirT
mrnwCBZJ0GtVeeCPBIyDUALheqtMPD3RdNl1glGQgwKBgQDo44o6Is1h7yC/NNJ+
nLdlCnrt2RI8aeKOuahgHSsapMgwiMJJqhUmh+wXIkoPvyIbpWr4TAjLAj9OMxzL
sbO+hR0iIxgej+LQPUDT+yW9SxAr3qcb5uT7buAJoU0pSmrxgBqp5xAth1cp1+iW
NG9VqvnvCHGBOYS+4+YQm1ZpNwKBgQDBKvfLj/terQcCDZRUHPmFojuT0sHEmSFO
kHXI7qC7IgZ/9kMRYsOd4btZ076TQqpZPKOukqpRmKrgmSimWBBfR9O4GNMoxL/8
S1Mesg0MlTZzdHEqQDSnHATXrrdy87CxFwdGMnWmgKsgGEeor/V9yG8dniKK0NzF
KDyutXrhhwKBgC8Kt0MjAIWFvgGhc9trYIgiY85jiJF3efIGgoJXoftRybY0CbrD
hl4wGnpZzMf9fbBD66WYBjarj4oGPQzQKlSTotzgZeDWg6Q4mz22f1sLLIsQAIVc
UGiRbuPDF0j95Tg+/iPPrq7jpbGoES02Dj8puC6WcAcATVYZxsEX/45lAoGAeNKH
a6wDbpSLbZ1QycvVxuBSo4OP74hYbOuuwJ+BqYr+xcsi6Bz+fiJTLTxkV3e7VVW4
i9jw71iuiQ1Df8hVdUNYCi585WMrMoNq2ihEQTqTdGPA5MyEIoJEBSQjWqNSQXJF
+oJVVG/mmYyWRczJoINd/QiMUoeRj0A7tIuO8MECgYEAo5mtwPmSxYztCBsXLnrM
orclU+bMwEfNoRSgzvEk5KffJoU5UQeskoDuWJAPOvb2BfoIvH+RjKaLvisglQy6
KGUcH/zB3ythOmeJhSTy0oQUMTfEqHmIxETGXxWkUArFyZF5J9p288VxlQf10YJf
ryQWOEsIjQEfDoXjl3gPsA8=
-----END PRIVATE KEY-----`

const CERTIFICATE_SPKI = "GK+DeLeX3/MuLYHlVKpVMVEQP+Ur6lUv+rPycUBlg9o="

async function body(request: import("node:http").IncomingMessage) {
  let value = ""
  for await (const chunk of request) value += String(chunk)
  return value
}

export async function startDesktopNativeAuthFixture(input: {
  upstreamOrigin: string
  accessToken: string
  refreshToken: string
}) {
  const authorizeRequests: URL[] = []
  const tokenRequests: URLSearchParams[] = []
  const revokeRequests: URLSearchParams[] = []
  let refreshes = 0
  let currentRefreshToken = input.refreshToken
  const authorizationCodes = new Map<string, { challenge: string; redirectUri: string }>()
  let serverOrigin = ""
  const clientId = "claxedo-desktop-e2e"
  const resource = () => `${serverOrigin}/control-plane`
  const issuer = () => `${serverOrigin}/api/auth`

  const server = createServer({ key: PRIVATE_KEY, cert: CERTIFICATE }, async (request, response) => {
    const url = new URL(request.url ?? "/", serverOrigin)
    if (request.method === "GET" && url.pathname === "/api/claxedo/auth/descriptor") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(
        JSON.stringify({
          adapter: "better-auth",
          deploymentId: "desktop-e2e-deployment",
          configurationVersion: "desktop-e2e-v1",
          expiresAt: Date.now() + 60 * 60_000,
          issuer: issuer(),
          methods: ["github"],
          browser: { trustedOrigins: [serverOrigin] },
          native: {
            cli: {},
            desktop: {
              flow: "authorization-code-pkce",
              clientId,
              resource: resource(),
              scopes: ["offline_access", "workspace:read", "workspace:write"],
              tokenEndpointOrigin: serverOrigin,
              controlPlaneOrigin: serverOrigin,
              revocation: {
                protocol: "rfc7009",
                endpoint: `${issuer()}/oauth2/revoke`,
                tokenEndpointAuthMethod: "none",
              },
            },
          },
        }),
      )
      return
    }
    if (request.method === "GET" && url.pathname === "/api/auth/oauth2/authorize") {
      authorizeRequests.push(url)
      const redirect = url.searchParams.get("redirect_uri")
      const state = url.searchParams.get("state")
      const challenge = url.searchParams.get("code_challenge")
      if (
        !redirect ||
        !state ||
        url.searchParams.get("client_id") !== clientId ||
        url.searchParams.get("resource") !== resource() ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !challenge
      ) {
        response.writeHead(400).end("invalid authorization request")
        return
      }
      const code = `fixture-code-${randomUUID()}`
      authorizationCodes.set(code, { challenge, redirectUri: redirect })
      const callback = new URL(redirect)
      callback.searchParams.set("code", code)
      callback.searchParams.set("state", state)
      response.writeHead(302, { location: callback.toString(), "cache-control": "no-store" }).end()
      return
    }
    if (request.method === "POST" && url.pathname === "/api/auth/oauth2/token") {
      const form = new URLSearchParams(await body(request))
      tokenRequests.push(form)
      if (form.get("client_id") !== clientId || form.get("resource") !== resource()) {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "invalid_request" }))
        return
      }
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code")
        const verifier = form.get("code_verifier")
        const redirectUri = form.get("redirect_uri")
        const authorization = code ? authorizationCodes.get(code) : undefined
        const verifierChallenge = verifier ? createHash("sha256").update(verifier).digest("base64url") : undefined
        if (
          !authorization ||
          redirectUri !== authorization.redirectUri ||
          verifierChallenge !== authorization.challenge
        ) {
          response
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "invalid_grant" }))
          return
        }
        authorizationCodes.delete(code!)
      } else if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== currentRefreshToken) {
          response
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "invalid_grant" }))
          return
        }
        currentRefreshToken = `desktop-e2e-refresh-${++refreshes}`
      } else {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "unsupported_grant_type" }))
        return
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(
        JSON.stringify({
          access_token: input.accessToken,
          refresh_token: currentRefreshToken,
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
      return
    }
    if (request.method === "POST" && url.pathname === "/api/auth/oauth2/revoke") {
      const form = new URLSearchParams(await body(request))
      revokeRequests.push(form)
      if (
        form.get("client_id") !== clientId ||
        form.get("token") !== currentRefreshToken ||
        form.get("token_type_hint") !== "refresh_token"
      ) {
        response.writeHead(400).end("invalid revocation")
        return
      }
      currentRefreshToken = "revoked"
      response.writeHead(200, { "cache-control": "no-store" }).end()
      return
    }

    const headers: import("node:http").OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || name === "host" || name === "connection" || name === "content-length") continue
      headers[name] = value
    }
    const requestBody = request.method === "GET" || request.method === "HEAD" ? undefined : await body(request)
    try {
      const upstreamUrl = new URL(`${url.pathname}${url.search}`, input.upstreamOrigin)
      await new Promise<void>((resolve, reject) => {
        const forward = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest
        const outgoing = forward(upstreamUrl, { method: request.method, headers }, (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers)
          incoming.pipe(response)
          incoming.once("end", resolve)
          incoming.once("error", reject)
        })
        outgoing.once("error", reject)
        outgoing.end(requestBody)
      })
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" }).end(`fixture upstream failed: ${String(error)}`)
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  serverOrigin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  const trustDir = await mkdtemp(join(tmpdir(), "claxedo-desktop-auth-ca-"))
  const caPath = join(trustDir, "ca.pem")
  await writeFile(caPath, CERTIFICATE, { mode: 0o600 })

  return {
    origin: serverOrigin,
    caPath,
    certificateSpki: CERTIFICATE_SPKI,
    authorizeRequests,
    tokenRequests,
    revokeRequests,
    refreshes: () => refreshes,
    binding: () => ({
      kind: "desktop",
      tokenKind: "access-token",
      adapter: "better-auth",
      deploymentId: "desktop-e2e-deployment",
      configurationVersion: "desktop-e2e-v1",
      issuer: issuer(),
      flow: "authorization-code-pkce",
      tokenEndpointOrigin: serverOrigin,
      controlPlaneOrigin: serverOrigin,
      id: clientId,
      resource: resource(),
      scopes: ["offline_access", "workspace:read", "workspace:write"],
    }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(trustDir, { recursive: true, force: true })
    },
  }
}

export type DesktopNativeAuthFixture = Awaited<ReturnType<typeof startDesktopNativeAuthFixture>>
