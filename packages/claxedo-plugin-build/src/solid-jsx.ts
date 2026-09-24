/// <reference path="./babel-presets.d.ts" />
import fs from "node:fs/promises"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import presetSolid from "babel-preset-solid"
import type { Plugin } from "esbuild"

export async function transformSolidJsx(source: string, filename: string): Promise<string> {
  const result = await transformAsync(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    presets: [
      [presetTypescript, { isTSX: true, allExtensions: true, onlyRemoveTypeImports: true }],
      [presetSolid, { generate: "dom", hydratable: false }],
    ],
  })
  if (!result || typeof result.code !== "string") throw new Error(`${filename}: the Solid JSX transform produced no code`)
  return result.code
}

export function solidJsxPlugin(): Plugin {
  return {
    name: "claxedo-plugin-solid-jsx",
    setup(build) {
      build.onLoad({ filter: /\.[jt]sx$/, namespace: "file" }, async (args) => ({
        contents: await transformSolidJsx(await fs.readFile(args.path, "utf8"), args.path),
        loader: "js",
      }))
    },
  }
}
