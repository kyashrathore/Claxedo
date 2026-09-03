import {
  AuthenticationError,
  type RequestAuthenticationAdapter,
} from "@claxedo/server-core/platform/auth/authentication"

export function testRequestAuthenticationAdapter(): RequestAuthenticationAdapter {
  return {
    descriptor: {
      adapter: "better-auth",
      deploymentId: "deployment-test",
      configurationVersion: "auth-test-v1",
      expiresAt: 4_102_444_800_000,
      issuer: "https://auth.test",
      methods: ["google"],
      browser: {
        transport: "cookie",
        credentialPolicy: "reject-cookie-and-authorization",
        trustedOrigins: ["https://app.test"],
        clientId: "claxedo-browser",
        resource: "https://core.test/control-plane",
        scopes: ["workspace:read", "workspace:write"],
        cookie: {
          name: "__Secure-claxedo.session_token",
          path: "/",
          secure: true,
          httpOnly: true,
          hostOnly: true,
          sameSite: "lax",
        },
      },
      native: {
        cli: {
          flow: "device-authorization",
          clientId: "claxedo-cli",
          resource: "https://core.test/control-plane",
          scopes: ["workspace:read", "workspace:write"],
          tokenEndpointOrigin: "https://auth.test",
          controlPlaneOrigin: "https://core.test",
          revocation: {
            protocol: "rfc7009",
            endpoint: "https://auth.test/oauth2/revoke",
            tokenEndpointAuthMethod: "none",
          },
        },
        desktop: {
          flow: "authorization-code-pkce",
          clientId: "claxedo-desktop",
          resource: "https://core.test/control-plane",
          scopes: ["workspace:read", "workspace:write"],
          tokenEndpointOrigin: "https://auth.test",
          controlPlaneOrigin: "https://core.test",
          revocation: {
            protocol: "rfc7009",
            endpoint: "https://auth.test/oauth2/revoke",
            tokenEndpointAuthMethod: "none",
          },
        },
      },
    },
    async authenticate(request) {
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const cookie = request.headers.get("cookie")?.includes("__Secure-claxedo.session_token=")
      if (!bearer && !cookie) {
        throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      }
      const id = bearer ?? "browser-user"
      return {
        userId: id,
        actorId: `actor:${id}`,
        actorKind: "human",
        deploymentId: "deployment-test",
        sessionId: `session:${id}`,
        authenticatedAt: 1_800_000_000_000,
        methods: ["oauth:google"],
        assurance: "single-factor",
        client: bearer
          ? {
              id: "claxedo-cli",
              kind: "cli",
              tokenKind: "access-token",
              resource: "https://core.test/control-plane",
              scopes: ["workspace:read"],
              deploymentId: "deployment-test",
              adapter: "better-auth",
              issuer: "https://auth.test",
              tokenEndpointOrigin: "https://auth.test",
              controlPlaneOrigin: "https://core.test",
            }
          : {
              id: "claxedo-browser",
              kind: "browser",
              tokenKind: "browser-session",
              resource: "https://core.test/control-plane",
              scopes: ["workspace:read"],
              origin: "https://app.test",
            },
        identity: { adapter: "better-auth", issuer: "https://auth.test", subject: id },
      }
    },
  }
}
