import { capabilitiesOf, type IntegrationCapability } from "./ports/index.js"
import type { IntegrationDeclaration, IntegrationImpl } from "./types.js"

/**
 * A declaration as the registry holds it: what its author wrote, plus the
 * capability set derived from the impl's ports.
 *
 * `capabilities` exists on this type and on no other. An author writes an
 * `IntegrationDeclaration`, which has no such field, so the set a connection
 * freezes as its grant is always the set the impl can actually serve.
 */
export type RegisteredIntegration = IntegrationDeclaration & {
  readonly capabilities: readonly IntegrationCapability[]
}

export type IntegrationRegistry = {
  register(decl: IntegrationDeclaration, impl: IntegrationImpl): void
  list(): RegisteredIntegration[]
  byId(id: string): { decl: RegisteredIntegration; impl: IntegrationImpl } | undefined
}

// Instance-based on purpose: the kit holds no module-global state. A host
// constructs one registry and registers the reference integrations it wants
// plus any userland integrations of its own.
export function createIntegrationRegistry(): IntegrationRegistry {
  const entries = new Map<string, { decl: RegisteredIntegration; impl: IntegrationImpl }>()
  return {
    register(decl, impl) {
      if (entries.has(decl.id)) throw new Error(`integration already registered: ${decl.id}`)
      const capabilities = capabilitiesOf(impl.actions)
      // An integration serving nothing can never be resolved for a capability
      // and can never grant one, so every connection made to it would be inert.
      // Refusing here names the mistake at its registration instead.
      if (capabilities.length === 0) throw new Error(`integration serves no capability: ${decl.id}`)
      entries.set(decl.id, { decl: { ...decl, capabilities }, impl })
    },
    list() {
      return [...entries.values()].map((entry) => entry.decl)
    },
    byId(id) {
      return entries.get(id)
    },
  }
}
