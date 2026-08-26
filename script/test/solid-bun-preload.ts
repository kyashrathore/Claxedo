import { Buffer } from "node:buffer"
import { readFileSync } from "node:fs"
import { transform } from "@dom-expressions/compiler"

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
const assetExtensions = /\.(svg|png|jpe?g|gif|webp|avif|mp3|wav|ogg)(\?.*)?$/

/** Bun keeps Vite-style `?url`/`?raw` suffixes on the path it hands to onLoad. */
const stripQuery = (path: string) => path.replace(/\?.*$/, "")

Bun.plugin({
  name: "solid-2-test-jsx",
  setup(build) {
    // Deliberately SYNCHRONOUS. An async onLoad makes every module it touches an
    // async module, and `require()` of an async module throws under Bun — which
    // is how a single `require("app/providers/config.tsx")` in a test-support
    // stub took out 50 tests. The compiler ships a sync `transform`, so the
    // hook has no reason to be async.
    //
    // The optional `?query` tail matters: tests that need the REAL module after
    // `mock.module` has replaced it re-import it under a cache-busting suffix
    // (`provider.tsx?session-commands-restore`). Bun keeps that suffix on the
    // path it hands to `onLoad`, so a bare /\.tsx$/ filter misses those modules,
    // and Bun transpiles their JSX itself against tsconfig's
    // `jsxImportSource: "@solidjs/web"` — which in Solid 2 has no `jsxDEV`
    // export, so the module fails to link and takes the whole file down.
    build.onLoad({ filter: /\.tsx(\?.*)?$/, namespace: "file" }, ({ path }) => {
      if (inNodeModules.test(path)) return
      const filename = stripQuery(path)

      const source = readFileSync(filename, "utf8")
      const result = transform(source, {
        filename,
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

    // Static-asset imports. Vite turns `import url from "./sprite.svg?url"`
    // (and bare image/audio imports) into the emitted asset's URL. Bun has no
    // such loader: it strips the `?url` query, sees a `.svg` or `.mp3`, and
    // hands the bytes to the JS/JSX parser — "Expected JSX element name but
    // found '?'" on the XML declaration, "Expected ';' but found ..." on an ID3
    // header. Either one surfaces as an unhandled module-load error that takes
    // down whichever test file first pulls in the icon sprites or the
    // notification sounds. Mirror Vite's contract with the file's own `file://`
    // URL; no test fetches it, they only hand it to `<use href>` or `new Audio`.
    build.onLoad({ filter: assetExtensions, namespace: "file" }, ({ path }) => ({
      contents: `export default ${JSON.stringify(Bun.pathToFileURL(stripQuery(path)).href)}`,
      loader: "js",
    }))
  },
})
