import type { ContentSurfaceContribution } from "../integrations/content-surface-contract"

/**
 * The single product-contribution registry.
 *
 * Two products compose this renderer. The unsigned desktop registers local
 * capabilities only; the hosted product adds WorkGraph, Documents, and the
 * rest of its surfaces. Before this seam existed the difference was a set of
 * runtime flags scattered across feature ports, which could hide a capability
 * but never remove it from the build.
 *
 * The distinction that makes this worth a module: `activateHosted` takes a
 * LOADER, not a set. The caller hands over a function that dynamically imports
 * the hosted module, so the hosted implementations are absent from the local
 * entry's static graph rather than merely unregistered. That is the property
 * Unit 12's emitted-artifact gate checks, and the reason a flag was never going
 * to be enough.
 *
 * Deliberately not a general plugin system. Unit 9 extends this with providers,
 * routes, settings sections, and navigation; Unit 10 supplies the
 * implementations from `@claxedo/cloud-app`. Anything beyond that belongs in
 * the contribution registry the surfaces already use.
 */

export type HostedContributionSet = {
  contentSurfaces: readonly ContentSurfaceContribution[]
}

export type HostedContributionLoader = () => Promise<HostedContributionSet>

export class ProductContributionError extends Error {
  constructor(
    readonly code: "duplicate_contribution_id" | "already_activated",
    message: string,
  ) {
    super(message)
    this.name = "ProductContributionError"
  }
}

/**
 * Content types the hosted set provides, as plain strings.
 *
 * Kept here rather than derived from `hostedContentSurfaces` on purpose:
 * reading them from the module would import it, which is the one thing the
 * local composition must not do. Restored-state pruning needs to know which
 * types a build can EVER render, and it has to know that synchronously, before
 * any activation has resolved.
 */
export const HOSTED_CONTENT_TYPES = [
  "page",
  "pages-index",
  "workgraph",
  "workspace-workgraph",
  "task-composer",
] as const

export type ProductContributions = {
  /** Content surfaces available before any account activation. */
  localContentSurfaces(): readonly ContentSurfaceContribution[]
  /**
   * Declare that this composition intends to activate the hosted set.
   *
   * Separate from `activateHosted` because activation is asynchronous and
   * restored-state pruning is not. A hosted build that pruned against
   * "registered right now" would delete every restored WorkGraph tab in the
   * window before the dynamic import resolves.
   */
  expectHosted(): void
  /** Whether hosted surfaces are expected, whether or not they have loaded. */
  hostedExpected(): boolean
  /** Every content type this composition can ever render. */
  availableContentTypes(): readonly string[]
  /** Whether the hosted set has been activated in this composition. */
  hostedActive(): boolean
  /**
   * Load and register the hosted set exactly once.
   *
   * Concurrent callers share one load: the signed-in event and a route that
   * needs a hosted surface can fire in either order, and registering the same
   * contributions twice would throw on the second pass rather than no-op.
   */
  activateHosted(loader: HostedContributionLoader): Promise<void>
}

export function createProductContributions(input: {
  local: readonly ContentSurfaceContribution[]
  register: (surface: ContentSurfaceContribution) => void
}): ProductContributions {
  const local = input.local
  const register = input.register
  const registered = new Set(local.map((surface) => surface.id))
  let activation: Promise<void> | undefined
  let expectsHosted = false

  return {
    localContentSurfaces: () => local,
    expectHosted() {
      expectsHosted = true
    },
    hostedExpected: () => expectsHosted,
    availableContentTypes: () => [
      ...local.map((surface) => String(surface.surface)),
      ...(expectsHosted ? HOSTED_CONTENT_TYPES : []),
    ],
    hostedActive: () => activation !== undefined,
    activateHosted(loader) {
      expectsHosted = true
      // Not `if (activation) return activation` inside an async function: the
      // await points would let a second caller enter before the first assigns,
      // and both would register.
      // Checked and assigned with no await between, which is what makes this
      // safe: `activateHosted` is synchronous and returns the promise, so a
      // second caller cannot arrive mid-assignment. (An `if` inside an ASYNC
      // function would have that bug, which is what the previous `??=` was
      // guarding against.)
      if (activation) return activation

      const attempt = (async () => {
        const hosted = await loader()
        // Validated against a set that grows as we check, not only against the
        // local ids. The previous version compared every hosted surface to
        // `registered` before adding any of them, so TWO HOSTED surfaces
        // sharing an id both passed and the second silently overwrote the
        // first — which is precisely the destination-reordering that stable
        // contribution ids exist to prevent.
        const claimed = new Set(registered)
        for (const surface of hosted.contentSurfaces) {
          if (claimed.has(surface.id)) {
            throw new ProductContributionError(
              "duplicate_contribution_id",
              `Hosted contribution "${surface.id}" is already registered; it would shadow the existing surface`,
            )
          }
          claimed.add(surface.id)
        }
        for (const surface of hosted.contentSurfaces) {
          registered.add(surface.id)
          register(surface)
        }
      })()

      // Caching only on success. `activation ??= …` kept the REJECTED promise,
      // so one transient chunk-load failure disabled hosted mode for the life
      // of the window with no way back — a signed user staring at a local-only
      // app until they reloaded.
      activation = attempt
      attempt.catch(() => {
        if (activation === attempt) activation = undefined
      })
      return attempt
    },
  }
}

/**
 * The composition every entry shares.
 *
 * Bound by `configureProductContributions` rather than constructed with a
 * static import of the surface list. This module is the CONTRACT; importing the
 * concrete local surfaces here would pull the entire renderer chain into
 * anything that wants to read `HOSTED_CONTENT_TYPES`, which is the opposite of
 * what a composition contract is for.
 *
 * Same `configureX(...)` port shape the runtime and feature ports already use.
 */
let instance: ProductContributions | undefined

export function configureProductContributions(input: {
  local: readonly ContentSurfaceContribution[]
  register: (surface: ContentSurfaceContribution) => void
}) {
  instance = createProductContributions(input)
  return instance
}

export function productContributions(): ProductContributions {
  if (!instance) {
    throw new Error("Product contributions are not configured; call configureProductContributions() from the app entry")
  }
  return instance
}

/**
 * Load the hosted contribution set.
 *
 * The dynamic import lives HERE rather than inside a local-owned module: this
 * is the one edge from the local composition to hosted code, and keeping it in
 * a single named place is what lets the boundary guards point at it.
 */
export function hostedContributionLoader(): HostedContributionLoader {
  return async () => {
    const hosted = await import("../integrations/hosted-content-surfaces")
    return { contentSurfaces: hosted.hostedContentSurfaces }
  }
}
