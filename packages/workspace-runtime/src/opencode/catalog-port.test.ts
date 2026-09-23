import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createCatalogPort } from "./catalog-port"
import type { OpenCodeHost } from "./host"
import { WorkspaceScope } from "./scope"

describe("catalog port models", () => {
  test("carries each model's effort variants by id and its cost tiers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-catalog-port-"))
    const host = {
      client: async () => ({
        model: {
          list: async () => ({
            data: [
              {
                providerID: "opencode",
                id: "reasoner",
                name: "Reasoner",
                variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "high" }],
                cost: [{ input: 0.3, output: 1.2, cache: { read: 0, write: 0 } }, { tier: { type: "context", size: 200000 }, input: 0.6, output: 2.4, cache: { read: 0, write: 0 } }],
              },
              { providerID: "opencode", id: "plain", name: "Plain", variants: [], cost: [] },
            ],
          }),
        },
      }),
    } as unknown as OpenCodeHost
    const scope = WorkspaceScope.authorize({ workspaceID: "ws", directory })

    expect(await createCatalogPort(host).models(scope)).toEqual([
      { providerID: "opencode", id: "reasoner", name: "Reasoner", variants: ["low", "high"], cost: [{ input: 0.3, output: 1.2 }, { input: 0.6, output: 2.4 }] },
      { providerID: "opencode", id: "plain", name: "Plain", cost: [] },
    ])
    fs.rmSync(directory, { recursive: true, force: true })
  })
})
