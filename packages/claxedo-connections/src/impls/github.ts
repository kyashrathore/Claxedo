import type {
  CodeHostRepository,
  ConnectionFields,
  DeviceAuth,
  DeviceGrant,
  DevicePoll,
  IntegrationDeclaration,
  IntegrationImpl,
  OAuthTokens,
  VerifyResult,
} from "../types.js"
import { DefinitiveRefreshError } from "../tokens.js"
import { timeoutFetch, type IntegrationFetchOptions } from "./fetch-timeout.js"

const DEVICE_CODE_URL = "https://github.com/login/device/code"
const TOKEN_URL = "https://github.com/login/oauth/access_token"
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

/**
 * Poll errors that will never turn into a token, split by whether restarting
 * the grant could help. `expired_token` is the user being too slow — a fresh
 * grant works. The rest are the app being misconfigured or the user saying no,
 * where another grant would fail identically.
 */
const RESTARTABLE_POLL_ERRORS = new Set(["expired_token", "incorrect_device_code"])
const TERMINAL_POLL_ERRORS = new Set([
  "access_denied",
  "device_flow_disabled",
  "incorrect_client_credentials",
  "unsupported_grant_type",
])

export type GitHubIntegrationOptions = IntegrationFetchOptions & {
  /**
   * The GitHub App's client id. Absent (self-hosters with no app of their
   * own), the integration declares the pasted-token method only — the oauth
   * button never appears rather than appearing and failing.
   */
  clientId?: string
  /**
   * Only used to refresh. GitHub does not require it for tokens minted by the
   * device flow, so a device-only deployment can omit it; it must never reach
   * a client either way.
   */
  clientSecret?: string
  now?: () => number
}

export function githubIntegration(options: GitHubIntegrationOptions = {}): {
  decl: IntegrationDeclaration
  impl: IntegrationImpl
} {
  const fetchImpl = timeoutFetch(options)
  const now = options.now ?? Date.now
  const clientId = options.clientId?.trim()
  const clientSecret = options.clientSecret?.trim()

  const form = async (url: string, params: Record<string, string>) =>
    fetchImpl(url, {
      method: "POST",
      headers: {
        // Without this the token endpoints answer form-encoded.
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "claxedo",
      },
      body: new URLSearchParams(params).toString(),
    })

  const toTokens = (body: Record<string, unknown>): OAuthTokens => ({
    accessToken: body.access_token as string,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" ? { expiresAt: now() + body.expires_in * 1000 } : {}),
  })

  const device: DeviceAuth = {
    async start(): Promise<DeviceGrant> {
      const res = await form(DEVICE_CODE_URL, { client_id: clientId! })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
        throw new Error("github_device_start_failed")
      }
      const interval = typeof body.interval === "number" ? body.interval : 5
      const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900
      return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : "https://github.com/login/device",
        intervalMs: interval * 1000,
        expiresAt: now() + expiresIn * 1000,
      }
    },
    async poll(deviceCode: string): Promise<DevicePoll> {
      const res = await form(TOKEN_URL, {
        client_id: clientId!,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }).catch(() => undefined)
      // Unreachable or broken upstream says nothing about the user's choice,
      // so the grant stays alive and the next poll asks again.
      if (!res || res.status >= 500) return { status: "pending" }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (typeof body.access_token === "string") return { status: "complete", tokens: toTokens(body) }
      const error = typeof body.error === "string" ? body.error : ""
      if (RESTARTABLE_POLL_ERRORS.has(error)) return { status: "expired" }
      if (TERMINAL_POLL_ERRORS.has(error)) return { status: "denied" }
      if (error === "slow_down" && typeof body.interval === "number") {
        return { status: "pending", intervalMs: body.interval * 1000 }
      }
      return { status: "pending" }
    },
  }

  return {
    decl: {
      id: "github",
      name: "GitHub",
      // OAuth first: it is the preferred path where the deployment has an app,
      // and the pasted token stays as the fallback that always works.
      methods: clientId ? ["oauth", "key"] : ["key"],
      capabilities: ["code-host", "work-source"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Fine-grained personal access token", secret: true }],
    },
    impl: {
      ...(clientId
        ? {
            device,
            async refresh(refreshToken: string): Promise<OAuthTokens> {
              const res = await form(TOKEN_URL, {
                client_id: clientId,
                ...(clientSecret ? { client_secret: clientSecret } : {}),
                grant_type: "refresh_token",
                refresh_token: refreshToken,
              })
              const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
              if (typeof body.access_token === "string") return toTokens(body)
              // A spent or rejected refresh token can only be repaired by
              // reconnecting, so it must not read as a retryable blip.
              if (typeof body.error === "string") throw new DefinitiveRefreshError(body.error)
              throw new Error("github_refresh_unavailable")
            },
          }
        : {}),
      async verify(_fields: ConnectionFields, secret: string): Promise<VerifyResult> {
        try {
          const res = await fetchImpl("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${secret}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "claxedo",
            },
          })
          if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" }
          if (!res.ok) return { ok: false, reason: "network" }
          const body = (await res.json().catch(() => ({}))) as { login?: unknown }
          return { ok: true, ...(typeof body.login === "string" ? { accountLabel: body.login } : {}) }
        } catch {
          return { ok: false, reason: "network" }
        }
      },
      async listRepositories(_fields: ConnectionFields, secret: string): Promise<CodeHostRepository[]> {
        const load = async (page: number, repositories: CodeHostRepository[]): Promise<CodeHostRepository[]> => {
          const res = await fetchImpl(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`, {
            headers: {
              Authorization: `Bearer ${secret}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "claxedo",
            },
          }).catch(() => undefined)
          if (!res) throw new Error("github_repositories_unavailable")
          if (res.status === 401 || res.status === 403) throw new Error("github_repositories_unauthorized")
          if (!res.ok) throw new Error("github_repositories_unavailable")
          const body = await res.json().catch(() => undefined)
          if (!Array.isArray(body)) throw new Error("github_repositories_invalid_response")
          const next = [...repositories, ...body.flatMap(repositoryFromGitHub)]
          if (body.length < 100 || page === 10) return next
          return load(page + 1, next)
        }
        return load(1, [])
      },
    },
  }
}

function repositoryFromGitHub(value: unknown): CodeHostRepository[] {
  if (!value || typeof value !== "object") return []
  const row = value as Record<string, unknown>
  if (
    (typeof row.id !== "number" && typeof row.id !== "string") ||
    typeof row.name !== "string" ||
    typeof row.full_name !== "string" ||
    typeof row.clone_url !== "string" ||
    typeof row.private !== "boolean"
  ) return []
  const permissions = row.permissions && typeof row.permissions === "object"
    ? row.permissions as Record<string, unknown>
    : {}
  return [{
    id: String(row.id),
    name: row.name,
    fullName: row.full_name,
    cloneUrl: row.clone_url,
    private: row.private,
    permissions: {
      read: permissions.pull === true || permissions.push === true || permissions.admin === true,
      write: permissions.push === true || permissions.admin === true,
    },
  }]
}
