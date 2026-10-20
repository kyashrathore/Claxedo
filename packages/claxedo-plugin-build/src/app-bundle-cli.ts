import { buildPluginApp } from "./build"
import { PluginBuildError } from "./errors"

const rootDir = process.argv[2]
if (!rootDir) {
  console.error("usage: bun app-bundle-cli.ts <plugin package directory>")
  process.exit(2)
}

try {
  const build = await buildPluginApp({ rootDir, minify: true })
  process.stdout.write(JSON.stringify({ manifest: build.manifest, hash: build.hash, code: build.code }))
} catch (error) {
  if (!(error instanceof PluginBuildError)) throw error
  for (const message of error.messages) console.error(message)
  process.exit(1)
}
