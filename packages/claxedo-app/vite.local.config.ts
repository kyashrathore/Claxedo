import { defineConfig, type UserConfig } from "vite"
import cloud from "./vite.cloud.config"

/**
 * The local product's build.
 *
 * Derived from the hosted config rather than copied, because everything that
 * makes the app buildable — the Solid plugin, Tailwind, the Shiki theme alias,
 * the dev proxy — is the same for both products and would drift if duplicated.
 * What differs is exactly two things, and they are both here so a reader can
 * see the whole difference at once:
 *
 *   1. A different HTML entry, which pulls `app/entry/local.tsx` instead of
 *      `main.tsx`. That single edge is what keeps the identity provider out of
 *      this bundle — see the note at the top of `local.tsx`.
 *   2. A different output directory, so a local build cannot overwrite the
 *      hosted one. Both are produced by CI, and `dist/` being whichever ran
 *      last is the kind of thing nobody notices until a deploy serves the
 *      wrong product.
 *
 * The default `dev`/`build` scripts deliberately still point at the hosted
 * config. The Pages workflow and the self-hosted Docker static build both
 * invoke them, so switching the default before cloud-app owns those callers
 * would deploy the local UI to a hosted surface.
 */
export default defineConfig((env) => {
  const base = (typeof cloud === "function" ? cloud(env as never) : cloud) as UserConfig

  return {
    ...base,
    build: {
      ...base.build,
      outDir: "dist-local",
      rollupOptions: {
        ...base.build?.rollupOptions,
        input: new URL("index.local.html", import.meta.url).pathname,
      },
    },
  }
})
