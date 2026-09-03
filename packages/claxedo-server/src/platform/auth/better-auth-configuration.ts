export const BETTER_AUTH_METHODS = ["google", "github", "email-password"] as const

export type BetterAuthMethod = (typeof BETTER_AUTH_METHODS)[number]

export type BetterAuthDeploymentConfigurationIdentity = {
  methods: readonly BetterAuthMethod[]
  apiOrigin: string
  appOrigin: string
  googleClientId?: string
  githubClientId?: string
}

export async function betterAuthDeploymentConfigurationId(configuration: BetterAuthDeploymentConfigurationIdentity) {
  const canonical = JSON.stringify({
    methods: [...configuration.methods].sort(),
    apiOrigin: configuration.apiOrigin,
    appOrigin: configuration.appOrigin,
    googleClientId: configuration.googleClientId ?? null,
    githubClientId: configuration.githubClientId ?? null,
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export type AuthEmailMessage = {
  kind: "verification" | "password-reset" | "invitation"
  recipient: string
  actionUrl: string
  token: string
}

/** Deployment-owned transactional email capability. */
export type AuthEmailSender = {
  send(message: AuthEmailMessage): Promise<void>
}

export type BetterAuthConfigurationEnv = Record<string, string | undefined>

export type BetterAuthConfiguration = {
  /** Safe to serialize into the origin-bound browser auth descriptor. */
  public: {
    adapter: "better-auth"
    methods: readonly BetterAuthMethod[]
    apiOrigin: string
    appOrigin: string
    trustedOrigins: readonly [string]
    callbacks: Partial<Record<"google" | "github", string>>
    sendsEmail: boolean
  }
  /** Worker-only values. This object must never cross the descriptor boundary. */
  private: {
    secret: string
    socialProviders: {
      google?: { clientId: string; clientSecret: string }
      github?: { clientId: string; clientSecret: string }
    }
    emailSender?: AuthEmailSender
  }
}

export class BetterAuthConfigurationError extends Error {
  constructor(
    public readonly code:
      | "missing_auth_methods"
      | "invalid_auth_method"
      | "duplicate_auth_method"
      | "missing_auth_secret"
      | "incomplete_google_credentials"
      | "incomplete_github_credentials"
      | "missing_email_sender"
      | "invalid_origin",
    message: string,
  ) {
    super(message)
    this.name = "BetterAuthConfigurationError"
  }
}

function requiredSecret(env: BetterAuthConfigurationEnv): string {
  const secret = env.BETTER_AUTH_SECRET?.trim()
  if (!secret || secret.length < 32) {
    throw new BetterAuthConfigurationError(
      "missing_auth_secret",
      "BETTER_AUTH_SECRET must be a deployment-owned secret of at least 32 characters",
    )
  }
  return secret
}

function exactHttpsOrigin(value: string | undefined, name: string): string {
  if (!value || value.includes("*")) {
    throw new BetterAuthConfigurationError("invalid_origin", `${name} must be an exact HTTPS origin`)
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new BetterAuthConfigurationError("invalid_origin", `${name} must be an exact HTTPS origin`)
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new BetterAuthConfigurationError("invalid_origin", `${name} must be an exact HTTPS origin`)
  }
  return parsed.origin
}

export function resolveBetterAuthMethodSelection(raw: string | undefined): BetterAuthMethod[] {
  const values = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  if (values.length === 0) {
    throw new BetterAuthConfigurationError(
      "missing_auth_methods",
      "CLAXEDO_AUTH_METHODS must select at least one interactive authentication method",
    )
  }

  const seen = new Set<string>()
  for (const value of values) {
    if (!(BETTER_AUTH_METHODS as readonly string[]).includes(value)) {
      throw new BetterAuthConfigurationError(
        "invalid_auth_method",
        `unsupported Better Auth method ${JSON.stringify(value)}`,
      )
    }
    if (seen.has(value)) {
      throw new BetterAuthConfigurationError(
        "duplicate_auth_method",
        `Better Auth method ${JSON.stringify(value)} is selected more than once`,
      )
    }
    seen.add(value)
  }

  return BETTER_AUTH_METHODS.filter((method) => seen.has(method))
}

function providerCredentials(
  env: BetterAuthConfigurationEnv,
  methods: readonly BetterAuthMethod[],
): BetterAuthConfiguration["private"]["socialProviders"] {
  const socialProviders: BetterAuthConfiguration["private"]["socialProviders"] = {}

  if (methods.includes("google")) {
    const clientId = env.GOOGLE_CLIENT_ID?.trim()
    const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim()
    if (!clientId || !clientSecret) {
      throw new BetterAuthConfigurationError(
        "incomplete_google_credentials",
        "Google authentication requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
      )
    }
    socialProviders.google = { clientId, clientSecret }
  }

  if (methods.includes("github")) {
    const clientId = env.GITHUB_CLIENT_ID?.trim()
    const clientSecret = env.GITHUB_CLIENT_SECRET?.trim()
    if (!clientId || !clientSecret) {
      throw new BetterAuthConfigurationError(
        "incomplete_github_credentials",
        "GitHub authentication requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET",
      )
    }
    socialProviders.github = { clientId, clientSecret }
  }

  return socialProviders
}

export function resolveBetterAuthConfiguration(input: {
  env: BetterAuthConfigurationEnv
  emailSender?: AuthEmailSender
  emailedInvitationsEnabled?: boolean
}): BetterAuthConfiguration {
  const methods = resolveBetterAuthMethodSelection(input.env.CLAXEDO_AUTH_METHODS)
  const apiOrigin = exactHttpsOrigin(input.env.BETTER_AUTH_URL, "BETTER_AUTH_URL")
  const appOrigin = exactHttpsOrigin(input.env.CLAXEDO_APP_ORIGIN, "CLAXEDO_APP_ORIGIN")
  const sendsEmail = methods.includes("email-password") || input.emailedInvitationsEnabled === true

  if (sendsEmail && !input.emailSender) {
    throw new BetterAuthConfigurationError(
      "missing_email_sender",
      "the selected authentication or invitation flow requires a deployment-owned AuthEmailSender",
    )
  }

  const callbacks: BetterAuthConfiguration["public"]["callbacks"] = {}
  if (methods.includes("google")) callbacks.google = `${apiOrigin}/api/auth/callback/google`
  if (methods.includes("github")) callbacks.github = `${apiOrigin}/api/auth/callback/github`

  return {
    public: {
      adapter: "better-auth",
      methods,
      apiOrigin,
      appOrigin,
      trustedOrigins: [appOrigin],
      callbacks,
      sendsEmail,
    },
    private: {
      secret: requiredSecret(input.env),
      socialProviders: providerCredentials(input.env, methods),
      ...(input.emailSender ? { emailSender: input.emailSender } : {}),
    },
  }
}
