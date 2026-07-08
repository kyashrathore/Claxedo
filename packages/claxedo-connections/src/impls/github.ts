import type { ConnectionFields, IntegrationDeclaration, IntegrationImpl, VerifyResult } from "../types.js"

export function githubIntegration(options: { fetchImpl?: typeof fetch } = {}): {
  decl: IntegrationDeclaration
  impl: IntegrationImpl
} {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    decl: {
      id: "github",
      name: "GitHub",
      methods: ["key"],
      capabilities: ["code-host"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Fine-grained personal access token", secret: true }],
    },
    impl: {
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
    },
  }
}
