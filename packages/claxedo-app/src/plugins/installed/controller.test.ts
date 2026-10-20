import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { PluginManifest } from "@claxedo/plugin-api"
import type { EnabledAppPlugin } from "@/server"
import type { PluginBuild, PluginSummary } from "../model"
import { createInstalledReconciler } from "./controller"

function manifest(id: string): PluginManifest {
  return { id, name: id, version: "0.1.0", app: "./src/app.js", requires: [], server: { routes: [], operations: [] } }
}

function enabled(id: string, sha256: string): EnabledAppPlugin {
  return { id, version: "0.1.0", manifest: manifest(id), appSha256: sha256 }
}

function fakeHost() {
  const [builds, setBuilds] = createSignal<readonly PluginBuild[]>([])
  return {
    plugins: () => builds().map((build) => ({ id: build.manifest.id, origin: build.origin }) as PluginSummary),
    put: (build: PluginBuild) => setBuilds((current) => [...current.filter((entry) => entry.manifest.id !== build.manifest.id), build]),
    drop: (pluginId: string) => setBuilds((current) => current.filter((entry) => entry.manifest.id !== pluginId)),
  }
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function settle() {
  return new Promise((done) => setTimeout(done, 0))
}

function reconcilerOver(host: ReturnType<typeof fakeHost>, gate?: Promise<void>) {
  const fetched: string[] = []
  const reconciler = createInstalledReconciler(host, async (plugin) => {
    fetched.push(`${plugin.id}@${plugin.appSha256}`)
    await gate
    return { manifest: plugin.manifest, origin: { kind: "installed", hash: plugin.appSha256, version: plugin.version }, definition: { activate: () => undefined } }
  })
  return { reconciler, fetched }
}

describe("the installed plugin list", () => {
  test("fetches only what the server lists as enabled for this person, once per bundle", async () => {
    const host = fakeHost()
    const { reconciler, fetched } = reconcilerOver(host)
    reconciler.reconcile([enabled("counter", "a".repeat(64))])
    reconciler.reconcile([enabled("counter", "a".repeat(64))])
    await settle()
    reconciler.reconcile([enabled("counter", "a".repeat(64))])
    expect(fetched).toEqual([`counter@${"a".repeat(64)}`])
    expect(host.plugins().map((plugin) => plugin.id)).toEqual(["counter"])
  })

  test("drops a plugin the list stops holding and does not fetch it again", async () => {
    const host = fakeHost()
    const { reconciler, fetched } = reconcilerOver(host)
    reconciler.reconcile([enabled("counter", "a".repeat(64)), enabled("notes", "b".repeat(64))])
    await settle()
    reconciler.reconcile([enabled("counter", "a".repeat(64))])
    reconciler.reconcile([enabled("counter", "a".repeat(64))])
    await settle()
    expect(host.plugins().map((plugin) => plugin.id)).toEqual(["counter"])
    expect(fetched).toEqual([`counter@${"a".repeat(64)}`, `notes@${"b".repeat(64)}`])
  })

})

describe("an installed plugin's load", () => {
  test("is discarded when the list stops holding its plugin before it finished", async () => {
    const host = fakeHost()
    const held = deferred()
    const { reconciler } = reconcilerOver(host, held.promise)
    reconciler.reconcile([enabled("notes", "c".repeat(64))])
    reconciler.reconcile([])
    held.resolve()
    await settle()
    expect(host.plugins()).toEqual([])
  })

  test("loads a new build when the server lists a new bundle for an installed plugin", async () => {
    const host = fakeHost()
    const { reconciler, fetched } = reconcilerOver(host)
    reconciler.reconcile([enabled("counter", "a".repeat(64))])
    await settle()
    reconciler.reconcile([enabled("counter", "d".repeat(64))])
    await settle()
    expect(fetched).toEqual([`counter@${"a".repeat(64)}`, `counter@${"d".repeat(64)}`])
    expect(host.plugins()[0]?.origin).toEqual({ kind: "installed", hash: "d".repeat(64), version: "0.1.0" })
  })
})
