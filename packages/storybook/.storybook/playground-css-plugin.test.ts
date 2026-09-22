import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { containedFile, devWriteAllowed, playgroundCssMiddleware } from "./playground-css-plugin"

/**
 * What the plugin resolves to. `realpathSync.native` is the canonical
 * spelling: on Windows the plain call answers the 8.3 short form of a temp
 * directory (`RUNNER~1`) while the native one answers `runneradmin`.
 */
function realPath(file: string) {
  return path.resolve(fs.realpathSync.native?.(file) ?? fs.realpathSync(file))
}

function tempTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "playground-css-"))
  const root = path.join(base, "components")
  const sibling = path.join(base, "components-evil")
  fs.mkdirSync(root)
  fs.mkdirSync(sibling)
  return { base, root, sibling }
}

describe("containedFile", () => {
  test("resolves a file inside the root", () => {
    const { base, root } = tempTree()
    try {
      const target = path.join(root, "card.css")
      fs.writeFileSync(target, "")
      expect(containedFile("card.css", [root])).toBe(realPath(target))
      expect(containedFile("nested/../card.css", [root])).toBe(realPath(target))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("refuses a sibling that shares the root as a string prefix", () => {
    const { base, root, sibling } = tempTree()
    try {
      const evil = path.join(sibling, "evil.css")
      fs.writeFileSync(evil, "")
      expect(containedFile("../components-evil/evil.css", [root])).toBeUndefined()
      expect(containedFile(evil, [root])).toBeUndefined()
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("refuses traversal and absolute paths outside the root", () => {
    const { base, root } = tempTree()
    try {
      const outside = path.join(base, "outside.css")
      fs.writeFileSync(outside, "")
      expect(containedFile("../outside.css", [root])).toBeUndefined()
      expect(containedFile(outside, [root])).toBeUndefined()
      expect(containedFile("missing.css", [root])).toBeUndefined()
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("refuses a symlink that points out of the root", () => {
    const { base, root } = tempTree()
    try {
      const outside = path.join(base, "secret.css")
      fs.writeFileSync(outside, "")
      fs.symlinkSync(outside, path.join(root, "link.css"))
      expect(containedFile("link.css", [root])).toBeUndefined()
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("devWriteAllowed", () => {
  const base = { remoteAddress: "127.0.0.1", host: "localhost:6006" }

  test("allows a same-origin loopback dev page", () => {
    expect(devWriteAllowed({ ...base, origin: "http://localhost:6006" })).toBe(true)
    expect(devWriteAllowed({ remoteAddress: "::1", host: "[::1]:6006", origin: "http://[::1]:6006" })).toBe(true)
    expect(devWriteAllowed({ ...base, remoteAddress: "::ffff:127.0.0.1" })).toBe(true)
    // Non-browser clients send no Origin; socket and host still decide.
    expect(devWriteAllowed(base)).toBe(true)
  })

  test("refuses a cross-origin write attempt", () => {
    expect(devWriteAllowed({ ...base, origin: "https://evil.example" })).toBe(false)
    expect(devWriteAllowed({ ...base, origin: "http://localhost.evil.example" })).toBe(false)
    expect(devWriteAllowed({ ...base, origin: "not a url" })).toBe(false)
  })

  test("refuses a non-loopback host or socket", () => {
    expect(devWriteAllowed({ ...base, host: "evil.example" })).toBe(false)
    expect(devWriteAllowed({ ...base, host: "localhost.evil.example" })).toBe(false)
    expect(devWriteAllowed({ ...base, remoteAddress: "192.168.1.20" })).toBe(false)
    expect(devWriteAllowed({ ...base, remoteAddress: undefined })).toBe(false)
  })
})

describe("dev server", () => {
  async function serve(root: string) {
    const middleware = playgroundCssMiddleware([root])
    const server = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("server reported no port")
    return { server, port: address.port }
  }

  function post(port: number, body: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; json: { results?: { ok: boolean }[]; error?: string } }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/__playground/apply-css",
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
        },
        (res) => {
          let buf = ""
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString()
          })
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf) }))
        },
      )
      req.on("error", reject)
      req.end(JSON.stringify(body))
    })
  }

  test("writes a contained file, refuses escapes and cross-origin writes", async () => {
    const { base, root, sibling } = tempTree()
    const target = path.join(root, "card.css")
    fs.writeFileSync(target, ".card {\n  color: red;\n}\n")
    const evil = path.join(sibling, "evil.css")
    fs.writeFileSync(evil, ".evil {\n  color: green;\n}\n")

    const { server, port } = await serve(root)
    const origin = { Origin: `http://localhost:${port}` }
    try {
      // Legitimate same-origin write applies.
      const applied = await post(
        port,
        { edits: [{ file: "card.css", anchor: ".card", prop: "color", value: "blue" }] },
        origin,
      )
      expect(applied.status).toBe(200)
      expect(applied.json.results?.[0]?.ok).toBe(true)
      expect(fs.readFileSync(target, "utf-8")).toContain("color: blue")

      // A sibling that shares the root as a string prefix is not a write
      // target, spelled relatively or absolutely.
      for (const file of ["../components-evil/evil.css", evil]) {
        const refused = await post(
          port,
          { edits: [{ file, anchor: ".evil", prop: "color", value: "red" }] },
          origin,
        )
        expect(refused.status).toBe(200)
        expect(refused.json.results ?? []).toHaveLength(0)
        expect(fs.readFileSync(evil, "utf-8")).toContain("color: green")
      }

      // Traversal to an existing file outside every root is refused too.
      const outside = path.join(base, "outside.css")
      fs.writeFileSync(outside, ".out {\n  color: green;\n}\n")
      const traversed = await post(
        port,
        { edits: [{ file: "../outside.css", anchor: ".out", prop: "color", value: "red" }] },
        origin,
      )
      expect(traversed.status).toBe(200)
      expect(traversed.json.results ?? []).toHaveLength(0)
      expect(fs.readFileSync(outside, "utf-8")).toContain("color: green")

      // A browser page on another origin cannot write, even over loopback.
      const crossOrigin = await post(
        port,
        { edits: [{ file: "card.css", anchor: ".card", prop: "color", value: "black" }] },
        { Origin: "https://evil.example" },
      )
      expect(crossOrigin.status).toBe(403)
      expect(fs.readFileSync(target, "utf-8")).toContain("color: blue")

      // Neither can a request whose Host header names a remote host.
      const spoofed = await post(
        port,
        { edits: [{ file: "card.css", anchor: ".card", prop: "color", value: "black" }] },
        { Host: "evil.example" },
      )
      expect(spoofed.status).toBe(403)
      expect(fs.readFileSync(target, "utf-8")).toContain("color: blue")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
