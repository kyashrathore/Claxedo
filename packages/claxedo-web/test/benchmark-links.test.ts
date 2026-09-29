import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { dev } from "astro"
import { benchmark } from "../src/config"

/** Astro's dev server ignores port 0 and falls back to 5173, so ask the OS for a free port first. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

describe("benchmark links", () => {
  test("every link to the benchmark on / opens in a new tab", async () => {
    const port = await freePort()
    const server = await dev({ root: new URL("..", import.meta.url).pathname, logLevel: "silent", server: { host: "127.0.0.1", port }, devToolbar: { enabled: false } })
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.address.port}/`)).text()
      const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]).filter((tag) => tag.includes(`href="${benchmark}`))
      expect(anchors.length).toBeGreaterThanOrEqual(2)
      for (const tag of anchors) {
        expect(tag).toContain('target="_blank"')
        expect(tag).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/)
      }
    } finally {
      await server.stop()
    }
  }, 60_000)
})
