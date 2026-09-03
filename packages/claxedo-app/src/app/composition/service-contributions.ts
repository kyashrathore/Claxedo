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
    // Read from the ports, not from `catalog`: a central that publishes no
    // catalog can still admit services (`activateAvailable`), and a content
    // type this composition cannot actually render must never be reported as
    // available because a descriptor said "enabled".
    availableContentTypes: () => [
      ...input.local.map((surface) => String(surface.surface)),
      ...FIRST_PARTY_SERVICE_IDS.filter((serviceId) => ports[serviceId].active()).flatMap(
        (serviceId) => SERVICE_CONTENT_TYPES[serviceId],
      ),
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
    /**
     * Activate every service this composition carries a loader for.
     *
     * For a central that publishes no catalog at all. Same closed order and
     * same all-or-nothing unwind as `apply`; it differs only in where the
     * permission comes from, so it deliberately leaves `catalog` empty rather
     * than inventing descriptors the central never issued.
     */
    async activateAvailable() {
      const activated: FirstPartyServiceId[] = []
      try {
        for (const serviceId of FIRST_PARTY_SERVICE_IDS) {
          if (!input.loaders[serviceId] || ports[serviceId].active()) continue
          await ports[serviceId].activate()
          activated.push(serviceId)
        }
      } catch (error) {
        for (const serviceId of activated.toReversed()) ports[serviceId].deactivate()
        throw error
      }
    },
    deactivateAll() {
      for (const serviceId of FIRST_PARTY_SERVICE_IDS) ports[serviceId].deactivate()
      catalog = []
    },
  }
}

export type ConfiguredServiceContributions = ReturnType<typeof createServiceContributions> & {
  applyAuthenticated(catalog: BrowserServiceCatalog): Promise<void>
  activateForLocalCentral(): Promise<void>
  signOut(): void
}

let configured: ConfiguredServiceContributions | undefined

export function configureServiceContributions(input: Omit<ServiceContributionsInput, "signedIn">) {
  /**
   * Which authority admitted the services this window holds.
   *
   * `principal` is a hosted central's signed catalog. `local-central` is a
   * loopback daemon: it has no principal, publishes no catalog, and its boot
   * aggregate carries neither field (`localBootstrapBody`,
   * packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts).
   * `documentsAccess` (src/features/documents/access.ts) already treats that
   * transport as full access, so on it the build's own loaders are the
   * authority — which is why account sign-out cannot revoke them: there is no
   * principal on a loopback central to sign out of.
   */
  let authority: "none" | "principal" | "local-central" = "none"
  const contributions = createServiceContributions({ ...input, signedIn: () => authority !== "none" })
  configured = {
    ...contributions,
    async applyAuthenticated(catalog) {
      authority = "principal"
      await contributions.apply(catalog)
    },
    async activateForLocalCentral() {
      authority = "local-central"
      await contributions.activateAvailable()
    },
    signOut() {
      if (authority === "local-central") return
      authority = "none"
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

/**
 * Admit this build's services on a central that issues no catalog.
 *
 * A loopback central is a single-user local daemon. It serves no
 * `GET /api/claxedo/services` and its boot aggregate carries no `services`
 * field, so `synchronizeServiceCatalogFromBootstrap` can only ever ignore it —
 * which left `page`, `pages-index` and the WorkGraph content types with no
 * registered surface at all in every composition whose central is loopback
 * (the desktop's own sidecar, and the browser lane's Tier M harness), even
 * though `documentsAccess` reports that transport as full access.
 *
 * Returns false when the composition configured no service loaders — an
 * unsigned local build, which genuinely ships none of these bundles.
 */
export async function activateServicesForLocalCentral() {
  const target = configuredServiceContributions()
  if (!target) return false
  await target.activateForLocalCentral()
  return true
}
