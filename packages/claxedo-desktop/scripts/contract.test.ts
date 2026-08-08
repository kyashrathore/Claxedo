import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { spec as desktopContractSpec, verify, write, type Spec } from "./contract"

const ROOT = path.resolve(import.meta.dir, "..")

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-contract-"))
}

function make(root: string, file: string, value: string) {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, value)
}

function spec(root: string): Spec {
  return {
    root,
    file: path.join(root, "dist/.build-contract.json"),
    input: ["src/app.ts", "config.json"],
    output: ["out/app.js", "resources/app.js"],
    match: [["out/app.js", "resources/app.js"]],
  }
}

test("verify passes for matching contract", () => {
  const root = temp()
  make(root, "src/app.ts", "export const n = 1\n")
  make(root, "config.json", "{}\n")
  make(root, "out/app.js", "console.log(1)\n")
  make(root, "resources/app.js", "console.log(1)\n")

  write(spec(root), "dev")

  expect(() => verify(spec(root), "dev")).not.toThrow()
  fs.rmSync(root, { recursive: true, force: true })
})

test("verify fails when an input drifts after build", () => {
  const root = temp()
  make(root, "src/app.ts", "export const n = 1\n")
  make(root, "config.json", "{}\n")
  make(root, "out/app.js", "console.log(1)\n")
  make(root, "resources/app.js", "console.log(1)\n")

  write(spec(root), "dev")
  make(root, "src/app.ts", "export const n = 2\n")

  expect(() => verify(spec(root), "dev")).toThrow("input changed: src/app.ts")
  fs.rmSync(root, { recursive: true, force: true })
})

test("verify fails when mirrored outputs diverge", () => {
  const root = temp()
  make(root, "src/app.ts", "export const n = 1\n")
  make(root, "config.json", "{}\n")
  make(root, "out/app.js", "console.log(1)\n")
  make(root, "resources/app.js", "console.log(1)\n")

  write(spec(root), "dev")
  make(root, "resources/app.js", "console.log(2)\n")

  expect(() => verify(spec(root), "dev")).toThrow("output changed: resources/app.js")
  fs.rmSync(root, { recursive: true, force: true })
})

test("the packaged output names the renderer document this product mode emits", () => {
  // The contract lists what a build must produce. It named `index.html`
  // unconditionally, which was correct only by accident: `VITE_AUTH_ENABLED=true`
  // is set in `claxedo-app/.env.local` and in `release-claxedo.yml`, so every
  // build anyone had ever run was the signed one. An unsigned build emits
  // `index.local.html` and nothing else, and would have failed its own contract
  // for a file it was never supposed to write.
  //
  // Driving `spec()` under both env shapes rather than reading the source: the
  // first version of this guard grepped `contract.ts` for the helper call, and
  // the mutation that hard-codes the document back SURVIVED it — the string was
  // present, the behaviour was not.
  const documentFor = (authEnabled: string | undefined) => {
    const previous = process.env.VITE_AUTH_ENABLED
    if (authEnabled === undefined) delete process.env.VITE_AUTH_ENABLED
    else process.env.VITE_AUTH_ENABLED = authEnabled
    try {
      return desktopContractSpec(ROOT).output.filter((entry) => entry.startsWith("out/renderer/") && entry.endsWith(".html"))
    } finally {
      if (previous === undefined) delete process.env.VITE_AUTH_ENABLED
      else process.env.VITE_AUTH_ENABLED = previous
    }
  }

  expect(documentFor("true")).toContain("out/renderer/index.html")
  expect(documentFor("true")).not.toContain("out/renderer/index.local.html")

  expect(documentFor(undefined)).toContain("out/renderer/index.local.html")
  expect(documentFor(undefined)).not.toContain("out/renderer/index.html")
})
