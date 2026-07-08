import type { ConnectionFields, IntegrationDeclaration, IntegrationImpl, VerifyResult } from "../types.js"

export function notionIntegration(options: { fetchImpl?: typeof fetch } = {}): {
  decl: IntegrationDeclaration
  impl: IntegrationImpl
} {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    decl: {
      id: "notion",
      name: "Notion",
      methods: ["key"],
      capabilities: ["docs"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Internal integration token", secret: true }],
    },
    impl: {
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
          const body = (await res.json().catch(() => ({}))) as { name?: unknown }
          return { ok: true, ...(typeof body.name === "string" ? { accountLabel: body.name } : {}) }
        } catch {
          return { ok: false, reason: "network" }
        }
      },
    },
  }
}
