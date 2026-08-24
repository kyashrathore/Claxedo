import { Buffer } from "node:buffer"
import { transformAsync } from "@dom-expressions/compiler"

const solidBuiltIns = [
  "For",
  "Show",
  "Switch",
  "Match",
  "Loading",
  "Reveal",
  "Portal",
  "Repeat",
  "Dynamic",
  "Errored",
]

const inNodeModules = /[\\/]node_modules[\\/]/

Bun.plugin({
  name: "solid-2-test-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/, namespace: "file" }, async ({ path }) => {
      if (inNodeModules.test(path)) return

      const source = await Bun.file(path).text()
      const result = await transformAsync(source, {
        filename: path,
        moduleName: "@solidjs/web",
        generate: "dom",
        hydratable: false,
        dev: true,
        sourceMap: true,
        contextToCustomElements: true,
        wrapConditionals: true,
        builtIns: solidBuiltIns,
      })

      const sourceMap = result.map
        ? `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(result.map).toString("base64")}`
        : ""

      // The Solid compiler owns JSX. Bun receives TypeScript without JSX and
      // only strips the remaining types; it must never synthesize jsx/jsxDEV.
      return { contents: `${result.code}${sourceMap}`, loader: "ts" }
    })
  },
})
