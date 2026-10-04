import { expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"

test("workerd accepts the Boat driver's redirect policy and the driver refuses a redirect", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { createBoatSandboxDriver } from "@claxedo/sandbox-manager/drivers/boat";
        export default { async fetch() {
          const driver = createBoatSandboxDriver({ apiKey: "test-key", image: "ghcr.io/claxedo/runtime:test", fetchImpl: async (url, init) => {
            new Request(url, init);
            return new Response(null, { status: 307, headers: { Location: "https://other.test" } });
          } });
          const input = { workspaceId: "ws1", homeRegion: "eu", epoch: 1, labels: {}, bootSource: { kind: "default" }, env: {} };
          return driver.ensureHost(input).then((result) => Response.json(result), (error) => Response.json({ code: error.code }));
        } };`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true, write: false, format: "esm", platform: "browser", conditions: ["development"],
  })
  const worker = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: bundle.outputFiles[0].text })
  try {
    expect(await (await worker.dispatchFetch("http://test/")).json()).toEqual({ code: "http_307" })
  } finally {
    await worker.dispose()
  }
})
