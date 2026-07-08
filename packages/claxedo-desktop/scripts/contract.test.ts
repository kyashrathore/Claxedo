import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { verify, write, type Spec } from "./contract"

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
