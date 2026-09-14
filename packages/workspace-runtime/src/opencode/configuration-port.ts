import type { OpenCodeHost } from "./host"
import { arr, rec, str } from "../json-value"

export type IntegrationConnection = Readonly<{ type: "credential" | "env"; id: string; label?: string }>
export type IntegrationEntry = Readonly<{
  id: string
  name: string
  methods: readonly unknown[]
  connections: readonly IntegrationConnection[]
}>

export type OpenCodeConfigurationPort = Readonly<{
  integrations(): Promise<readonly IntegrationEntry[]>
  removeCredential(credentialID: string): Promise<void>
}>

function data(response: unknown): unknown {
  const row = rec(response)
  return row && "data" in row ? row.data : response
}

export function createConfigurationPort(host: OpenCodeHost): OpenCodeConfigurationPort {
  return {
    async integrations() {
      const value = data(await (await host.client()).integration.list())
      if (!Array.isArray(value)) throw new Error("OpenCode returned an invalid integration list")
      return value.map((item) => {
        const row = rec(item) ?? {}
        const projected: IntegrationConnection[] = []
        for (const entry of arr(row.connections) ?? []) {
          const connection = rec(entry)
          if (!connection) continue
          const id = str(connection.id)
          const name = str(connection.name)
          const label = str(connection.label)
          if (connection.type === "credential" && id !== undefined) {
            projected.push({ type: "credential", id, ...(label === undefined ? {} : { label }) })
          } else if (connection.type === "env" && name !== undefined) {
            projected.push({ type: "env", id: name })
          }
        }
        return {
          id: str(row.id) ?? "",
          name: str(row.name) ?? "",
          methods: arr(row.methods) ?? [],
          connections: projected,
        }
      })
    },
    async removeCredential(credentialID) {
      await (await host.client()).credential.remove({ credentialID })
    },
  }
}
