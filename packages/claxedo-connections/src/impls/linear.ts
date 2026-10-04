import { workSourcePort } from "../ports/index.js"
import type { ConnectionFields, IntegrationDeclaration, IntegrationImpl, VerifyResult } from "../types.js"
import { timeoutFetch, type IntegrationFetchOptions } from "./fetch-timeout.js"
import { record, text } from "../json.js"

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
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Personal API key", createUrl: "https://linear.app/settings/account/security", secret: true }],
    },
    impl: {
      actions: { "work-source": workSourcePort },
      auth: {
        async verify(_fields: ConnectionFields, secret: string): Promise<VerifyResult> {
          try {
            const response = await fetchImpl("https://api.linear.app/graphql", {
              method: "POST",
              headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
              body: JSON.stringify({ query: "query ConnectionViewer { viewer { name email } }" }),
            })
            if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" }
            if (!response.ok) return { ok: false, reason: "network" }
            const body = record(await response.json().catch(() => ({}))) ?? {}
            const viewer = record(record(body.data)?.viewer)
            const errors = body.errors
            if ((Array.isArray(errors) && errors.length > 0) || !viewer) return { ok: false, reason: "unauthorized" }
            const label = text(viewer.name) ?? text(viewer.email)
            return { ok: true, ...(label ? { accountLabel: label } : {}) }
          } catch {
            return { ok: false, reason: "network" }
          }
        },
      },
    },
  }
}
