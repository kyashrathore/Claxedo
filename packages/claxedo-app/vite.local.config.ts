import { defineConfig, type UserConfig } from "vite"
import cloud from "./vite.cloud.config"
import { fileURLToPath } from "node:url"

import { productBoundaryBuildManifestPlugin } from "../../script/product-boundary/rollup-build-manifest-plugin"

/**
 * Packages a local build has no identity provider to use.
 *
 * The same list `src/architecture/local-entry-closure.guard.test.ts` walks the
 * source graph for, applied here to the CHUNK table instead. Kept as package
 * prefixes rather than exact ids so a subpath (`@clerk/clerk-js/headless`) is
 * matched by its package.
 */
const FORBIDDEN_LOCAL_PACKAGES = ["@clerk/clerk-js", "convex"]

const namesForbiddenPackage = (ids: readonly unknown[]) =>
  ids.some(
    (id) =>
      typeof id === "string" &&
      FORBIDDEN_LOCAL_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`)),
  )

/**
 * The local product's build.
 *
 * Derived from the hosted config rather than copied, because everything that
 * makes the app buildable — the Solid plugin, Tailwind, the Shiki theme alias,
 * the dev proxy — is the same for both products and would drift if duplicated.
 * What differs is exactly three things, and they are all here so a reader can
 * see the whole difference at once:
 *
 *   1. A different HTML entry, which pulls `app/entry/local.tsx` instead of
 *      `main.tsx`. That single edge is what keeps the identity provider out of
 *      this bundle — see the note at the top of `local.tsx`.
 *   2. A different output directory, so a local build cannot overwrite the
 *      hosted one. Both are produced by CI, and `dist/` being whichever ran
 *      last is the kind of thing nobody notices until a deploy serves the
 *      wrong product.
 *   3. No manual chunk named for a package this product must not contain. The
 *      hosted config declares a `vendor-clerk` chunk; spreading its Rollup
 *      options carried that declaration into a build whose whole purpose is to
 *      have no identity provider in it.
 *
 *      Measured, not assumed: a local build that KEPT the entry emitted a
 *      116-byte `vendor-clerk-*.js` holding one CommonJS interop helper and no
 *      Clerk code, because nothing in the local entry's graph imports Clerk and
 *      Rollup tree-shook it away. So the inherited entry was not shipping
 *      hosted identity code — but it was naming a chunk after a dependency this
 *      build must never contain, and that name is load-bearing in the wrong
 *      direction: it made "is Clerk in the local artifact?" answerable only by
 *      opening the file, and it would have become true rather than misleading
 *      the moment Clerk grew a retained top-level side effect. The emitted
 *      artifact is checked directly by `scripts/check-local-bundle-identity.ts`,
 *      because the source-graph guard cannot see either case.
 *
 * The default `dev`/`build` scripts deliberately still point at the hosted
 * config. The Pages workflow and the self-hosted Docker static build both
 * invoke them, so switching the default before cloud-app owns those callers
 * would deploy the local UI to a hosted surface.
 */
export default defineConfig((env) => {
  const base = (typeof cloud === "function" ? cloud(env as never) : cloud) as UserConfig
  const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url))

  // Refused rather than worked around. Both shapes are expressible and neither
  // is what the hosted config does today; inheriting one silently would mean
  // this build could no longer say which chunks it excludes, which is the whole
  // job of the filter below.
  const output = base.build?.rollupOptions?.output
  if (Array.isArray(output)) {
    throw new Error("vite.local.config: the hosted config emits multiple outputs; the local chunk filter covers one")
  }
  const manualChunks = output?.manualChunks
  if (typeof manualChunks === "function") {
    throw new Error("vite.local.config: the hosted config computes manualChunks; the local filter reads the table form")
  }

  return {
    ...base,
    plugins: [
      ...(base.plugins ?? []),
      productBoundaryBuildManifestPlugin({
        entry: fileURLToPath(new URL("./src/app/entry/local.tsx", import.meta.url)),
        file: fileURLToPath(new URL("./.artifacts/u8-package-split/manifests/app-local.json", import.meta.url)),
        workspaceRoot,
      }),
    ],
    build: {
      ...base.build,
      outDir: "dist-local",
      rollupOptions: {
        ...base.build?.rollupOptions,
        input: new URL("index.local.html", import.meta.url).pathname,
        output: {
          ...output,
          // Filtered by what a chunk CONTAINS, not by its name. Dropping a
          // hard-coded "vendor-clerk" key would go stale the day the hosted
          // config renamed the chunk, and go stale silently — the local build
          // would inherit the renamed entry and nothing here would say so.
          manualChunks: Object.fromEntries(
            Object.entries(manualChunks ?? {}).filter(
              ([, ids]) => !(Array.isArray(ids) && namesForbiddenPackage(ids)),
            ),
          ),
        },
      },
    },
  }
})
