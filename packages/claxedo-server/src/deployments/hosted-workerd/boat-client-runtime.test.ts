import { expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"

test("Boat create uses a redirect policy accepted by workerd and refuses redirected credentials", async () => {
  const client = fileURLToPath(new URL("../../../../sandbox-manager/src/drivers/boat-client.ts", import.meta.url))
  const bundle = await build({
    stdin: {
      contents: `import { createBoatClient } from ${JSON.stringify(client)};
        export default { async fetch(request) {
          const client = createBoatClient({ apiKey: "test-key", fetchImpl: async (url, init) => {
            const outbound = new Request(url, init);
            if (new URL(request.url).pathname === "/redirect") return new Response(null, { status: 307, headers: { Location: "https://other.test" } });
            return Response.json({ ok: true, type: "sandbox.created", sandbox: { id: "bx_23456789", state: "provisioning" } });
          } });
          try { return Response.json(await client.create({ idempotencyKey: "test:1", ttlSeconds: null })); }
          catch (error) { return Response.json({ code: error.code, message: error.message }, { status: 502 }); }
        } };`,
      loader: "ts",
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true, write: false, format: "esm", platform: "browser", conditions: ["development"],
  })
  const worker = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: bundle.outputFiles[0].text })
  try {
    const created = await worker.dispatchFetch("http://test/create")
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ id: "bx_23456789", state: "provisioning" })
    const redirected = await worker.dispatchFetch("http://test/redirect")
    expect(redirected.status).toBe(502)
    expect(await redirected.json()).toMatchObject({ code: "redirect_refused" })
  } finally {
    await worker.dispose()
  }
})
