import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { emittedManifestFindings } from "./emitted-manifest"
import { serializeBuildManifest, type BuildManifest } from "./normalize-build-manifest"
import type { Policy } from "./policy"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(manifest?: BuildManifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-emitted-manifest-"))
  roots.push(root)
  const file = "artifact/manifest.json"
  if (manifest) {
    fs.mkdirSync(path.join(root, "artifact"), { recursive: true })
    fs.writeFileSync(path.join(root, file), serializeBuildManifest(manifest))
  }
  const policy: Policy = {
    id: "fixture",
    summary: "fixture",
    packageDir: "packages/app",
    entry: "packages/app/src/index.ts",
    roots: ["packages/app/src"],
    forbiddenPackages: ["@clerk/clerk-js"],
    forbiddenModules: ["packages/app/src/hosted"],
    control: { minModules: 1, requiredModules: [] },
    emitted: {
      file,
      minModules: 2,
      minChunks: 1,
      requiredModules: ["packages/app/src/index.ts"],
      forbiddenChunkMarkers: ["clerk"],
    },
  }
  return { root, policy }
}

describe("emitted manifest boundary", () => {
  test("accepts a populated manifest from the declared entry", () => {
    const { root, policy } = fixture({
      entry: "packages/app/src/index.ts",
      modules: ["packages/app/src/index.ts", "solid-js/dist/solid.js"],
      chunks: ["assets/index-abc.js"],
      edges: { static: [], dynamic: [] },
    })
    expect(emittedManifestFindings(policy, root)).toEqual([])
  })

  test("refuses missing and empty measurements", () => {
    const missing = fixture()
    expect(emittedManifestFindings(missing.policy, missing.root)).toEqual([
      "missing emitted manifest: artifact/manifest.json",
    ])

    const empty = fixture({ entry: "wrong.ts", modules: [], chunks: [], edges: { static: [], dynamic: [] } })
    expect(emittedManifestFindings(empty.policy, empty.root)).toEqual(expect.arrayContaining([
      "entry is wrong.ts; expected packages/app/src/index.ts",
      "manifest has 0 modules; expected at least 2",
      "manifest has 0 chunks; expected at least 1",
      "required emitted module missing: packages/app/src/index.ts",
    ]))
  })

  test("rejects forbidden package, source-root, and chunk identities", () => {
    const { root, policy } = fixture({
      entry: "packages/app/src/index.ts",
      modules: [
        "packages/app/src/index.ts",
        "packages/app/src/hosted/private.ts",
        "@clerk/clerk-js/dist/index.js",
      ],
      chunks: ["assets/vendor-clerk.js"],
      edges: { static: [], dynamic: [] },
    })
    expect(emittedManifestFindings(policy, root)).toEqual([
      "forbidden emitted module packages/app/src/hosted: packages/app/src/hosted/private.ts",
      "forbidden emitted package @clerk/clerk-js: @clerk/clerk-js/dist/index.js",
      "forbidden emitted chunk marker clerk: assets/vendor-clerk.js",
    ])
  })
})
