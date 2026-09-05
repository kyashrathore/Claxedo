import { expect, test } from "bun:test"
import { build } from "esbuild"
import { piModelCatalog as sourceCatalog } from "./harnesses/pi/catalog"
import { piModelCatalog } from "../dist/pi-catalog.mjs"

test("published Pi metadata exactly matches its canonical build source and returns isolated data", () => {
  expect(piModelCatalog()).toEqual(sourceCatalog())
  piModelCatalog()[0]!.models.splice(0)
  expect(piModelCatalog()).toEqual(sourceCatalog())
})

test("Pi metadata bundles for a Worker without native or external runtime imports", async () => {
  const result = await build({
    entryPoints: [new URL("../dist/pi-catalog.mjs", import.meta.url).pathname],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
  })
  expect(Object.keys(result.metafile!.inputs)).toHaveLength(1)
  expect(Object.values(result.metafile!.inputs)[0]!.imports).toEqual([])
})
