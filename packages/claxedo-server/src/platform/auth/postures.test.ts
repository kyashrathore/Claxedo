import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import {
  RouteNotFoundError,
  RoutePosture,
  internalAdmin,
  localOnly,
  publicRoute,
  serviceToken,
  signedUser,
} from "./postures"

/**
 * Loopback is decided by the request URL's host (plus the absence of any
 * forwarding header), not by a header we could set — `isLoopbackLocalRequest`
 * fails closed the moment `x-forwarded-for` is present, precisely so a client
 * cannot claim to be local.
 */
function request(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3001/route", { headers })
}

function remoteRequest(headers: Record<string, string> = {}) {
  return new Request("https://control-plane.test/route", { headers })
}

const SIGNED_CONFIG = {
  enabled: true as const,
  issuer: "https://issuer.test",
  jwksUrl: "https://issuer.test/jwks",
}

const LOCAL_CONFIG = { enabled: false as const, mode: "local-only" as const, reason: "disabled" }

function verifierFor(subject: string) {
  return vi.fn(async () => ({
    mode: "signed" as const,
    user: { subject, tokenIdentifier: `t_${subject}`, issuer: "https://issuer.test" },
  }))
}

describe("route postures", () => {
  test("localOnly refuses a non-loopback caller, so a desktop-only surface cannot be reached remotely", () => {
    expect(() => localOnly(remoteRequest())).toThrow(ControlPlaneAuthError)
    expect(localOnly(request())).toEqual({ posture: RoutePosture.LocalOnly })
  })

  test("localOnly refuses a forwarded request even when it claims a loopback client, so a proxy header cannot forge local access", () => {
    expect(() => localOnly(request({ "x-forwarded-for": "127.0.0.1" }))).toThrow(ControlPlaneAuthError)
  })

  test("localOnly still refuses a non-loopback caller that presents a valid-looking bearer, so a token cannot buy entry to a loopback surface", () => {
    expect(() => localOnly(remoteRequest({ authorization: "Bearer whatever" }))).toThrow(
      ControlPlaneAuthError,
    )
  })

  test("signedUser refuses a request with no bearer when signed auth is enabled, so a hosted route cannot be reached anonymously", async () => {
    await expect(signedUser(request(), { authConfig: SIGNED_CONFIG })).rejects.toMatchObject({
      status: 401,
      code: "missing_bearer_token",
    })
  })

  test("signedUser returns the verified identity, so a handler attributes work to the caller rather than to 'local'", async () => {
    const result = await signedUser(request({ authorization: "Bearer good" }), {
      authConfig: SIGNED_CONFIG,
      verifier: verifierFor("user_1"),
    })
    expect(result.posture).toBe(RoutePosture.SignedUser)
    expect(result.auth?.user.subject).toBe("user_1")
  })

  test("signedUser passes through unsigned-local so the desktop app, which configures no issuer, is not locked out of its own routes", async () => {
    const result = await signedUser(request(), { authConfig: LOCAL_CONFIG })
    expect(result).toEqual({ posture: RoutePosture.SignedUser })
  })

  test("signedUser fails closed with 503 when signed auth is requested but misconfigured, rather than falling back to open", async () => {
    await expect(
      signedUser(request({ authorization: "Bearer good" }), {
        authConfig: { enabled: false, mode: "misconfigured", reason: "issuer missing" },
      }),
    ).rejects.toMatchObject({ status: 503 })
  })

  test("serviceToken refuses a wrong secret and admits the right one, so a machine surface is not reachable by guessing", () => {
    expect(() => serviceToken(request({ authorization: "Bearer wrong" }), "expected")).toThrow(
      ControlPlaneAuthError,
    )
    expect(serviceToken(request({ authorization: "Bearer expected" }), "expected")).toEqual({
      posture: RoutePosture.ServiceToken,
    })
  })

  test("serviceToken refuses when no secret is configured, so an unconfigured deployment does not accept every token", () => {
    expect(() => serviceToken(request({ authorization: "Bearer anything" }), undefined)).toThrow(
      ControlPlaneAuthError,
    )
    expect(() => serviceToken(request({ authorization: "Bearer anything" }), "   ")).toThrow(
      ControlPlaneAuthError,
    )
  })

  test("internalAdmin answers 404 when unconfigured, so probing cannot distinguish a disabled operator surface from a missing one", () => {
    expect(() => internalAdmin(request({ authorization: "Bearer x" }), undefined)).toThrow(
      RouteNotFoundError,
    )
    // A 401 here would confirm the surface exists and is merely locked.
    try {
      internalAdmin(request({ authorization: "Bearer x" }), undefined)
    } catch (err) {
      expect((err as RouteNotFoundError).status).toBe(404)
    }
  })

  test("internalAdmin admits only the configured operator secret", () => {
    expect(internalAdmin(request({ authorization: "Bearer op" }), "op")).toEqual({
      posture: RoutePosture.InternalAdmin,
    })
    expect(() => internalAdmin(request({ authorization: "Bearer nope" }), "op")).toThrow(
      ControlPlaneAuthError,
    )
  })

  test("publicRoute demands a written reason, so an unauthenticated route cannot be created by leaving an argument empty", () => {
    expect(() => publicRoute("")).toThrow(/requires a reason/)
    expect(publicRoute("JWKS is public by definition")).toEqual({ posture: RoutePosture.Public })
  })
})
