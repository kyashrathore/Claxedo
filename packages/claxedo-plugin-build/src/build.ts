import { createHash } from "node:crypto"
import { build as esbuild, formatMessages, type Message } from "esbuild"
import type { PluginManifest } from "@claxedo/plugin-api"
import { PluginBuildError } from "./errors"
import { readPluginPackage } from "./manifest-file"
import { runtimeShimPlugin } from "./runtime-shims"
import { solidJsxPlugin } from "./solid-jsx"

export const PLUGIN_BUNDLE_HASH_LENGTH = 16

export type PluginBuildOptions = {
  rootDir: string
  minify?: boolean
}

export type PluginBuild = {
  manifest: PluginManifest
  code: string
  hash: string
  warnings: readonly string[]
}

export function pluginBundleHash(manifest: PluginManifest, code: string): string {
  return createHash("sha256").update(JSON.stringify(manifest)).update("\n").update(code).digest("hex").slice(0, PLUGIN_BUNDLE_HASH_LENGTH)
}

function isBuildFailure(error: unknown): error is { errors: Message[]; warnings: Message[] } {
  return typeof error === "object" && error !== null && Array.isArray((error as { errors?: unknown }).errors)
}

async function formatted(messages: Message[], kind: "error" | "warning"): Promise<string[]> {
  return (await formatMessages(messages, { kind, color: false })).map((message) => message.trimEnd())
}

export async function buildPluginApp(options: PluginBuildOptions): Promise<PluginBuild> {
  const pkg = await readPluginPackage(options.rootDir)
  try {
    const result = await esbuild({
      entryPoints: [pkg.appEntry],
      absWorkingDir: pkg.rootDir,
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: options.minify ?? false,
      legalComments: "none",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [runtimeShimPlugin(), solidJsxPlugin()],
    })
    const output = result.outputFiles.find((file) => file.path.endsWith(".js")) ?? result.outputFiles[0]
    if (!output) throw new PluginBuildError("bundle", [`${pkg.appEntry}: esbuild produced no output`])
    const code = output.text
    return { manifest: pkg.manifest, code, hash: pluginBundleHash(pkg.manifest, code), warnings: await formatted(result.warnings, "warning") }
  } catch (error) {
    if (error instanceof PluginBuildError) throw error
    if (isBuildFailure(error)) throw new PluginBuildError("bundle", await formatted(error.errors, "error"))
    throw error
  }
}
