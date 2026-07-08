import type { IntegrationDeclaration, IntegrationImpl } from "./types.js"

export type IntegrationRegistry = {
  register(decl: IntegrationDeclaration, impl: IntegrationImpl): void
  list(): IntegrationDeclaration[]
  byId(id: string): { decl: IntegrationDeclaration; impl: IntegrationImpl } | undefined
}

// Instance-based on purpose: the kit holds no module-global state. A host
// constructs one registry and registers the reference integrations it wants
// plus any userland integrations of its own.
export function createIntegrationRegistry(): IntegrationRegistry {
  const entries = new Map<string, { decl: IntegrationDeclaration; impl: IntegrationImpl }>()
  return {
    register(decl, impl) {
      if (entries.has(decl.id)) throw new Error(`integration already registered: ${decl.id}`)
      entries.set(decl.id, { decl, impl })
    },
    list() {
      return [...entries.values()].map((entry) => entry.decl)
    },
    byId(id) {
      return entries.get(id)
    },
  }
}
