import { expect, test } from "bun:test"
import { createContext, createRoot, getOwner, runWithOwner, useContext, type Owner } from "solid-js"
import type { PluginApi } from "@claxedo/plugin-api"
import { activatePlugin } from "./activation"
import type { PluginBuild } from "./model"

const HostContext = createContext<string>()

function host(value: string) {
  return createRoot((dispose) => {
    let owner!: Owner
    HostContext.Provider({ value, get children() { owner = getOwner()!; return undefined } })
    return { owner, dispose }
  })
}

test.each(["after loading", "under another host"])("activation reads its own host's context %s", async (scenario) => {
  const [own, other] = [host("own"), host("other")]
  let read: string | undefined
  const build: PluginBuild = {
    manifest: { id: "fixture", name: "Fixture", version: "0.1.0", app: "./app.tsx", requires: [], server: { routes: [], operations: [] } },
    origin: { hash: "a".repeat(16), directory: "/tmp/fixture" },
    definition: {
      activate: () => {
        read = useContext(HostContext)
      },
    },
  }
  const activate = () => activatePlugin({ build, owner: own.owner, onCrash: () => undefined, buildApi: () => ({}) as PluginApi })
  await Promise.resolve()
  const activation = await (scenario === "after loading" ? activate() : runWithOwner(other.owner, activate)!)
  expect(read).toBe("own")
  activation.dispose()
  own.dispose()
  other.dispose()
})
