import {
  FIRST_PARTY_SERVICE_IDS,
  requireBrowserServiceCatalog,
  type BrowserServiceCatalog,
  type FirstPartyServiceId,
} from "@claxedo/service-contract"
import type { ContentSurfaceContribution } from "../integrations/content-surface-contract"
import {
  createContentSurfaceActivation,
  type HostedContributionLoader,
} from "./product-contributions"

export const SERVICE_CONTENT_TYPES = {
  workgraph: ["workgraph", "workspace-workgraph", "task-composer"],
  documents: ["page", "pages-index"],
} as const satisfies Record<FirstPartyServiceId, readonly string[]>

export type ServiceContributionLoaders = Partial<Record<FirstPartyServiceId, HostedContributionLoader>>

export type ServiceContributionsInput = {
  local: readonly ContentSurfaceContribution[]
  loaders: ServiceContributionLoaders
  signedIn(): boolean
  register(surface: ContentSurfaceContribution): void
  unregister(surface: ContentSurfaceContribution): void
}

export function createServiceContributions(input: ServiceContributionsInput) {
  const localIds = () => input.local.map((surface) => surface.id)
  const installedIds = new Set<string>()
  const ports = Object.fromEntries(FIRST_PARTY_SERVICE_IDS.map((serviceId) => [
    serviceId,
    createContentSurfaceActivation({
      signedIn: input.signedIn,
      load: async () => {
        const loader = input.loaders[serviceId]
        if (!loader) throw new Error(`${serviceId} contribution loader is not configured`)
        return (await loader()).contentSurfaces
      },
      register(surface) {
        input.register(surface)
        installedIds.add(surface.id)
      },
      unregister(surface) {
        input.unregister(surface)
        installedIds.delete(surface.id)
      },
      registeredIds: () => [...localIds(), ...installedIds],
    }),
  ])) as Record<FirstPartyServiceId, ReturnType<typeof createContentSurfaceActivation>>
  let catalog: BrowserServiceCatalog = []

  return {
    catalog: () => catalog,
    availableContentTypes: () => [
      ...input.local.map((surface) => String(surface.surface)),
      ...catalog
        .filter((descriptor) => descriptor.state === "enabled")
        .flatMap((descriptor) => SERVICE_CONTENT_TYPES[descriptor.serviceId]),
    ],
    active: (serviceId: FirstPartyServiceId) => ports[serviceId].active(),
    async apply(next: BrowserServiceCatalog) {
      const normalized = requireBrowserServiceCatalog(next)
      const installed = new Map(normalized.map((descriptor) => [descriptor.serviceId, descriptor]))
      const activated: FirstPartyServiceId[] = []
      try {
        // Activate in the closed service-id order. Besides making failures
        // deterministic, this lets each bundle validate its ids against every
        // service that was installed before it.
        for (const serviceId of FIRST_PARTY_SERVICE_IDS) {
          if (installed.get(serviceId)?.state !== "enabled" || ports[serviceId].active()) continue
          await ports[serviceId].activate()
          activated.push(serviceId)
        }
      } catch (error) {
        // A catalog is one authenticated snapshot. Never publish or leave a
        // partially activated snapshot when one service bundle is invalid.
        for (const serviceId of activated.toReversed()) ports[serviceId].deactivate()
        throw error
      }
      // Only enabled services own their real renderer. Disabled recovery state
      // is metadata, not permission to retain tenant data in a feature bundle.
      for (const serviceId of FIRST_PARTY_SERVICE_IDS) {
        if (installed.get(serviceId)?.state !== "enabled") ports[serviceId].deactivate()
      }
      catalog = normalized
    },
    deactivateAll() {
      for (const serviceId of FIRST_PARTY_SERVICE_IDS) ports[serviceId].deactivate()
      catalog = []
    },
  }
}

export type ConfiguredServiceContributions = ReturnType<typeof createServiceContributions> & {
  applyAuthenticated(catalog: BrowserServiceCatalog): Promise<void>
  signOut(): void
}

let configured: ConfiguredServiceContributions | undefined

export function configureServiceContributions(input: Omit<ServiceContributionsInput, "signedIn">) {
  let signed = false
  const contributions = createServiceContributions({ ...input, signedIn: () => signed })
  configured = {
    ...contributions,
    async applyAuthenticated(catalog) {
      signed = true
      await contributions.apply(catalog)
    },
    signOut() {
      signed = false
      contributions.deactivateAll()
    },
  }
  return configured
}

export function configuredServiceContributions() {
  return configured
}

/**
 * Follow the core's explicit authentication result.
 *
 * An absent marker belongs to a non-hosted/older local bootstrap shape and is
 * ignored. Explicit `false` is authoritative session expiry/sign-out and must
 * remove already loaded services before the app publishes healthy boot state.
 */
export async function synchronizeServiceCatalogFromBootstrap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const bootstrap = value as Record<string, unknown>
  const target = configuredServiceContributions()
  if (!target) return false
  if (bootstrap.authenticated === false) {
    target.signOut()
    return true
  }
  if (bootstrap.authenticated !== true) return false
  await target.applyAuthenticated(requireBrowserServiceCatalog(bootstrap.services ?? []))
  return true
}
