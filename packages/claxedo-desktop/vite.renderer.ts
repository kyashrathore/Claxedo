import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ConfigEnv, UserConfig } from "vite"
import type { PluginOption } from "vite"
import { cloudConfig } from "../claxedo-app/vite.cloud.config"
import { WEB_CONTENT_SECURITY_POLICY_PLUGIN } from "../claxedo-app/vite.content-security-policy"
import { desktopRendererBoundaryManifestPlugin } from "./scripts/product-boundary-manifests"

const normalize = (value: string) => value.replaceAll("\\", "/")

export const desktopDir = normalize(fileURLToPath(new URL("./", import.meta.url)))
const appDir = normalize(fileURLToPath(new URL("../claxedo-app/", import.meta.url)))
const rendererRoot = normalize(fileURLToPath(new URL("./src/renderer/", import.meta.url)))

export function desktopRendererChunk(id: string) {
  // Mermaid's two class-diagram entries emit identical dynamic chunks.
  return /mermaid[^]*\/classDiagram/.test(id) ? "mermaid-classDiagram" : undefined
}

function appAliases(config: UserConfig) {
  const aliases = config.resolve?.alias
  if (!Array.isArray(aliases)) throw new Error("the app's Vite config no longer declares its aliases as a list")
  return [
    { find: /^#app$/, replacement: normalize(path.join(appDir, "src/app.tsx")) },
    { find: /^#app\/styles$/, replacement: normalize(path.join(appDir, "src/styles.ts")) },
    ...aliases,
  ]
}

type RendererOutput = NonNullable<NonNullable<UserConfig["build"]>["rollupOptions"]>["output"]

function desktopOutput(output: RendererOutput): RendererOutput {
  if (Array.isArray(output)) return output.map((item) => ({ ...item, manualChunks: desktopRendererChunk }))
  return { ...output, manualChunks: desktopRendererChunk }
}

function isWebContentSecurityPolicy(plugin: PluginOption) {
  return typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === WEB_CONTENT_SECURITY_POLICY_PLUGIN
}

function localServerUrl() {
  return process.env.VITE_CLAXEDO_SERVER_URL?.trim() || "http://127.0.0.1:2593"
}

export function createElectronRenderer(env: ConfigEnv): UserConfig {
  const app = cloudConfig(env, "desktop")
  return {
    ...app,
    root: rendererRoot,
    base: "./",
    publicDir: normalize(path.join(appDir, "public")),
    plugins: [
      ...(app.plugins ?? []).filter((plugin) => !isWebContentSecurityPolicy(plugin)),
      desktopRendererBoundaryManifestPlugin(desktopDir),
    ],
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api/claxedo/credentials": { target: localServerUrl(), changeOrigin: true },
        "/api/claxedo/integrations": { target: localServerUrl(), changeOrigin: true },
      },
    },
    resolve: { ...app.resolve, alias: appAliases(app) },
    build: {
      ...app.build,
      outDir: undefined,
      // electron-vite's renderer preset defaults minify off; without this the
      // renderer ships its main chunk unminified (6.7 MB instead of 3.7 MB).
      minify: "esbuild",
      rollupOptions: {
        ...app.build?.rollupOptions,
        output: desktopOutput(app.build?.rollupOptions?.output),
        input: {
          main: normalize(path.join(rendererRoot, "index.local.html")),
          loading: normalize(path.join(rendererRoot, "loading.html")),
        },
      },
    },
  }
}
