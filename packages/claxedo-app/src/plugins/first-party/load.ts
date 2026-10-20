import { throwingDefinition } from "../bundle"
import { failureReason } from "../failure"
import { frameDefinition } from "../frame/definition"
import type { FrameHost } from "../frame/open"
import { importInApp } from "../in-app"
import type { PluginBuild } from "../model"
import type { FirstPartyBundle, PluginBundle } from "./model"

export type BundleLoader = (bundle: PluginBundle) => Promise<PluginBuild>

function bundledBuild(bundle: PluginBundle, rest: Pick<PluginBuild, "definition" | "dictionary">): PluginBuild {
  return { manifest: bundle.manifest, origin: { kind: "bundled", hash: bundle.hash }, ...rest }
}

export function inAppBundleLoader(): BundleLoader {
  return async (bundle) => {
    try {
      return bundledBuild(bundle, await importInApp(bundle.manifest.id, bundle.code))
    } catch (error) {
      return bundledBuild(bundle, { definition: throwingDefinition(error) })
    }
  }
}

export function frameBundleLoader(frame: FrameHost): BundleLoader {
  return (bundle) => Promise.resolve(bundledBuild(bundle, { definition: frameDefinition({ ...frame, code: bundle.code, backend: Boolean(bundle.manifest.backend) }) }))
}

export class FirstPartyBundleError extends Error {
  constructor(readonly pluginId: string, reason: string) {
    super(`The built-in app plugin ${pluginId} could not be loaded: ${reason}`)
    this.name = "FirstPartyBundleError"
  }
}

export function loadFirstPartyPlugins(bundles: readonly FirstPartyBundle[], load: BundleLoader, put: (build: PluginBuild) => void): () => void {
  let stopped = false
  for (const entry of bundles) {
    void entry
      .load()
      .then(async ({ default: bundle }) => {
        if (bundle.manifest.id !== entry.id) throw new FirstPartyBundleError(entry.id, `the bundle declares the id ${bundle.manifest.id}`)
        const build = await load(bundle)
        if (!stopped) put(build)
      })
      .catch((error: unknown) => console.error(new FirstPartyBundleError(entry.id, failureReason(error))))
  }
  return () => {
    stopped = true
  }
}
