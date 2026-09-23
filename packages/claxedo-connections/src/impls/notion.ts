import { docsPort } from "../ports/index.js"
import type { ConnectionFields, IntegrationDeclaration, IntegrationImpl, VerifyResult } from "../types.js"
import { timeoutFetch, type IntegrationFetchOptions } from "./fetch-timeout.js"
import { record, text } from "../json.js"

export function notionIntegration(options: IntegrationFetchOptions = {}): {
  decl: IntegrationDeclaration
  impl: IntegrationImpl
} {
  const fetchImpl = timeoutFetch(options)
  return {
    decl: {
      id: "notion",
      name: "Notion",
      methods: ["key"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Internal integration token", createUrl: "https://www.notion.so/profile/integrations", secret: true }],
    },
    impl: {
      actions: { docs: docsPort },
      auth: {
        async verify(_fields: ConnectionFields, secret: string): Promise<VerifyResult> {
          try {
            const res = await fetchImpl("https://api.notion.com/v1/users/me", {
              headers: {
                Authorization: `Bearer ${secret}`,
                "Notion-Version": "2022-06-28",
              },
            })
            if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" }
            if (!res.ok) return { ok: false, reason: "network" }
            const name = text(record(await res.json().catch(() => ({})))?.name)
            return { ok: true, ...(name ? { accountLabel: name } : {}) }
          } catch {
            return { ok: false, reason: "network" }
          }
        },
      },
    },
  }
}
