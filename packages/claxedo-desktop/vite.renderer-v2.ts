import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ConfigEnv, UserConfig } from "vite"
import appV2Config from "../claxedo-app-v2/vite.cloud.config"
import { rendererDocumentCsp } from "./vite.renderer"

const normalize = (value: string) => value.replaceAll("\\", "/")

const appV2Dir = normalize(fileURLToPath(new URL("../claxedo-app-v2/", import.meta.url)))
const rendererRoot = normalize(fileURLToPath(new URL("./src/renderer-v2/", import.meta.url)))

function appV2Aliases(config: UserConfig) {
  const aliases = config.resolve?.alias
  if (!Array.isArray(aliases)) throw new Error("claxedo-app-v2's Vite config no longer declares its aliases as a list")
  return [
    { find: /^#app-v2$/, replacement: normalize(path.join(appV2Dir, "src/app.tsx")) },
    { find: /^#app-v2\/styles$/, replacement: normalize(path.join(appV2Dir, "src/ui/styles.css")) },
    ...aliases,
  ]
}

type RendererOutput = NonNullable<NonNullable<UserConfig["build"]>["rollupOptions"]>["output"]

function withoutManualChunks(output: RendererOutput): RendererOutput {
  if (output === undefined || Array.isArray(output)) return output
  return { ...output, manualChunks: undefined }
}

export function createElectronRendererV2(env: ConfigEnv): UserConfig {
  const app = appV2Config(env)
  return {
    ...app,
    root: rendererRoot,
    base: "./",
    publicDir: normalize(path.join(appV2Dir, "public")),
    plugins: [...(app.plugins ?? []), rendererDocumentCsp(env.mode)],
    server: { host: "127.0.0.1" },
    resolve: { ...app.resolve, alias: appV2Aliases(app) },
    build: {
      ...app.build,
      rollupOptions: {
        ...app.build?.rollupOptions,
        output: withoutManualChunks(app.build?.rollupOptions?.output),
        input: {
          main: normalize(path.join(rendererRoot, "index.local.html")),
          loading: normalize(path.join(rendererRoot, "loading.html")),
        },
      },
    },
  }
}
