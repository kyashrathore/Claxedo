import type { OpenCodeHost } from "./host"

export type IntegrationConnection = Readonly<{ type: "credential" | "env"; id: string; label?: string }>
export type IntegrationEntry = Readonly<{
  id: string
  name: string
  methods: readonly unknown[]
  connections: readonly IntegrationConnection[]
}>

export type OpenCodeConfigurationPort = Readonly<{
  integrations(): Promise<readonly IntegrationEntry[]>
  connectKey(input: { integrationID: string; key: string; label?: string }): Promise<void>
  removeCredential(credentialID: string): Promise<void>
}>

function data(response: unknown): unknown {
  if (response && typeof response === "object" && "data" in response) {
    return (response as { data?: unknown }).data
  }
  return response
}

function record(response: unknown): Readonly<Record<string, unknown>> {
  const value = data(response)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenCode returned an invalid object response")
  }
  return value as Readonly<Record<string, unknown>>
}

export function createConfigurationPort(host: OpenCodeHost): OpenCodeConfigurationPort {
  return {
    async integrations() {
      const value = data(await (await host.client()).integration.list())
      if (!Array.isArray(value)) throw new Error("OpenCode returned an invalid integration list")
      return value.map((item) => {
        const row = item as Record<string, unknown>
        const connections = Array.isArray(row.connections) ? row.connections : []
        const projected: IntegrationConnection[] = []
        for (const item of connections) {
          const connection = item as Record<string, unknown>
          if (connection.type === "credential" && typeof connection.id === "string") {
            projected.push({ type: "credential", id: connection.id, ...(typeof connection.label === "string" ? { label: connection.label } : {}) })
          } else if (connection.type === "env" && typeof connection.name === "string") {
            projected.push({ type: "env", id: connection.name })
          }
        }
        return {
          id: String(row.id),
          name: String(row.name),
          methods: Array.isArray(row.methods) ? row.methods : [],
          connections: projected,
        }
      })
    },
    async connectKey(input) {
      await (await host.client()).integration.connect.key({
        integrationID: input.integrationID,
        key: input.key,
        ...(input.label ? { label: input.label } : {}),
      })
    },
    async removeCredential(credentialID) {
      await (await host.client()).credential.remove({ credentialID })
    },
  }
}
