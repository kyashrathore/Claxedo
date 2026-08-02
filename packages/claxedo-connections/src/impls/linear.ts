import type { ConnectionFields, IntegrationDeclaration, IntegrationImpl, VerifyResult } from "../types.js"
import { timeoutFetch, type IntegrationFetchOptions } from "./fetch-timeout.js"

export function linearIntegration(options: IntegrationFetchOptions = {}): {
  decl: IntegrationDeclaration
  impl: IntegrationImpl
} {
  const fetchImpl = timeoutFetch(options)
  return {
    decl: {
      id: "linear",
      name: "Linear",
      methods: ["key"],
      capabilities: ["work-source"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Personal API key", secret: true }],
    },
    impl: {
      async verify(_fields: ConnectionFields, secret: string): Promise<VerifyResult> {
        try {
          const response = await fetchImpl("https://api.linear.app/graphql", {
            method: "POST",
            headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
            body: JSON.stringify({ query: "query ConnectionViewer { viewer { name email } }" }),
          })
          if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" }
          if (!response.ok) return { ok: false, reason: "network" }
          const body = await response.json().catch(() => ({})) as { data?: { viewer?: { name?: unknown; email?: unknown } }; errors?: unknown[] }
          if (body.errors?.length || !body.data?.viewer) return { ok: false, reason: "unauthorized" }
          const label = typeof body.data.viewer.name === "string" ? body.data.viewer.name : body.data.viewer.email
          return { ok: true, ...(typeof label === "string" ? { accountLabel: label } : {}) }
        } catch {
          return { ok: false, reason: "network" }
        }
      },
    },
  }
}
