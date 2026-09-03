import { describe, expect, test } from "bun:test"
import { SERVICE_PROTOCOL_VERSION, type BrowserServiceDescriptor } from "@claxedo/service-contract"
import { HostedContributionError } from "@/platform/account/hosted-contribution-port"

import {
  activateServicesForLocalCentral,
  configureServiceContributions,
  createServiceContributions,
  synchronizeServiceCatalogFromBootstrap,
} from "./service-contributions"
import type { ContentSurfaceContribution } from "../integrations/content-surface-contract"

const surface = (id: string, type: string) => ({
  id,
  tier: "claxedo-first-party",
  surface: type,
  slot: "workbench",
  renderer: () => null,
}) as ContentSurfaceContribution

function descriptor(
  serviceId: "workgraph" | "documents",
  state: "installed_disabled" | "enabled",
): BrowserServiceDescriptor {
  return {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    state,
    serviceId,
  }
}

describe("first-party service contributions", () => {
  test("an empty catalog loads neither WorkGraph nor Documents", async () => {
    const loaded: string[] = []
    const registered: string[] = []
    const contributions = createServiceContributions({
      local: [],
      signedIn: () => true,
      loaders: {
        workgraph: async () => { loaded.push("workgraph"); return { contentSurfaces: [surface("wg", "workgraph")] } },
        documents: async () => { loaded.push("documents"); return { contentSurfaces: [surface("docs", "page")] } },
      },
      register: (item) => registered.push(item.id),
      unregister: (item) => registered.splice(registered.indexOf(item.id), 1),
    })

    await contributions.apply([])
    expect(loaded).toEqual([])
    expect(registered).toEqual([])
    expect(contributions.availableContentTypes()).toEqual([])
  })

  test("loads only enabled services and removes an active service when disabled", async () => {
    const loaded: string[] = []
    const registered: string[] = []
    const contributions = createServiceContributions({
      local: [],
      signedIn: () => true,
      loaders: {
        workgraph: async () => { loaded.push("workgraph"); return { contentSurfaces: [surface("wg", "workgraph")] } },
        documents: async () => { loaded.push("documents"); return { contentSurfaces: [surface("docs", "page")] } },
      },
      register: (item) => registered.push(item.id),
      unregister: (item) => registered.splice(registered.indexOf(item.id), 1),
    })

    await contributions.apply([descriptor("workgraph", "enabled")])
    expect(loaded).toEqual(["workgraph"])
    expect(registered).toEqual(["wg"])
    await contributions.apply([descriptor("workgraph", "installed_disabled")])
    expect(registered).toEqual([])
    expect(contributions.availableContentTypes()).toEqual([])
    await contributions.apply([])
    expect(registered).toEqual([])
  })

  test("rejects a surface id claimed by two independently loaded services", async () => {
    const registered: string[] = []
    const contributions = createServiceContributions({
      local: [],
      signedIn: () => true,
      loaders: {
        workgraph: async () => ({ contentSurfaces: [surface("shared", "workgraph")] }),
        documents: async () => ({ contentSurfaces: [surface("shared", "page")] }),
      },
      register: (item) => registered.push(item.id),
      unregister: (item) => registered.splice(registered.indexOf(item.id), 1),
    })

    await expect(contributions.apply([
      descriptor("workgraph", "enabled"),
      descriptor("documents", "enabled"),
    ])).rejects.toMatchObject({ code: "shadows_registered_contribution" } satisfies Partial<HostedContributionError>)
    expect(registered).toEqual([])
    expect(contributions.catalog()).toEqual([])
  })

  test("activates from signed bootstrap only and removes services on sign-out", async () => {
    const loaded: string[] = []
    const registered: string[] = []
    const contributions = configureServiceContributions({
      local: [],
      loaders: {
        workgraph: async () => { loaded.push("workgraph"); return { contentSurfaces: [surface("wg", "workgraph")] } },
        documents: async () => { loaded.push("documents"); return { contentSurfaces: [surface("docs", "page")] } },
      },
      register: (item) => registered.push(item.id),
      unregister: (item) => registered.splice(registered.indexOf(item.id), 1),
    })

    expect(await synchronizeServiceCatalogFromBootstrap({ authenticated: false, services: [descriptor("workgraph", "enabled")] })).toBe(true)
    expect(loaded).toEqual([])
    expect(await synchronizeServiceCatalogFromBootstrap({ authenticated: true, services: [descriptor("workgraph", "enabled")] })).toBe(true)
    expect(loaded).toEqual(["workgraph"])
    expect(registered).toEqual(["wg"])
    expect(await synchronizeServiceCatalogFromBootstrap({ authenticated: false, services: [] })).toBe(true)
    expect(registered).toEqual([])
    expect(contributions.catalog()).toEqual([])
    expect(contributions.availableContentTypes()).toEqual([])
  })

  test("a loopback central admits every configured loader and sign-out cannot revoke it", async () => {
    const loaded: string[] = []
    const registered: string[] = []
    const contributions = configureServiceContributions({
      local: [],
      loaders: {
        documents: async () => { loaded.push("documents"); return { contentSurfaces: [surface("docs", "pages-index")] } },
      },
      register: (item) => registered.push(item.id),
      unregister: (item) => registered.splice(registered.indexOf(item.id), 1),
    })

    expect(await activateServicesForLocalCentral()).toBe(true)
    expect(loaded).toEqual(["documents"])
    expect(registered).toEqual(["docs"])
    // A service the composition ships no loader for stays absent — the build is
    // the authority here, so it can admit nothing it cannot load.
    expect(contributions.active("workgraph")).toBe(false)
    // Reported from the ports, not from a catalog this central never issued.
    expect(contributions.catalog()).toEqual([])
    expect(contributions.availableContentTypes()).toEqual(["page", "pages-index"])

    // There is no principal on a loopback central, so the account reporting
    // "not signed" is not a revocation of anything.
    contributions.signOut()
    expect(registered).toEqual(["docs"])
  })

  test("a composition with no service loaders configured admits nothing on a loopback central", async () => {
    const registered: string[] = []
    const contributions = configureServiceContributions({
      local: [],
      loaders: {},
      register: (item) => registered.push(item.id),
      unregister: (item) => registered.splice(registered.indexOf(item.id), 1),
    })

    expect(await activateServicesForLocalCentral()).toBe(true)
    expect(registered).toEqual([])
    expect(contributions.availableContentTypes()).toEqual([])
  })

  test("a newer anonymous bootstrap fences an older enabled catalog still loading", async () => {
    let release: (() => void) | undefined
    const registered: string[] = []
    configureServiceContributions({
      local: [],
      loaders: {
        workgraph: async () => {
          await new Promise<void>((resolve) => { release = resolve })
          return { contentSurfaces: [surface("wg", "workgraph")] }
        },
      },
      register: (item) => registered.push(item.id),
      unregister: (item) => registered.splice(registered.indexOf(item.id), 1),
    })

    const stale = synchronizeServiceCatalogFromBootstrap({
      authenticated: true,
      services: [descriptor("workgraph", "enabled")],
    })
    await Promise.resolve()
    await synchronizeServiceCatalogFromBootstrap({ authenticated: false, services: [] })
    release?.()

    await expect(stale).rejects.toMatchObject({ code: "activation_abandoned" })
    expect(registered).toEqual([])
  })
})
