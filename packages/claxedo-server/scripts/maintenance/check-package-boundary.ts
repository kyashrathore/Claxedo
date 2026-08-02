import path from "node:path"
import { fileURLToPath } from "node:url"

export function forbiddenPackagePath(file: string) {
  const base = path.basename(file)
  if (base.startsWith(".env") && base !== ".env.example") return true
  if (file.split("/").some((part) => part === "node_modules" || part === ".cache" || part === ".sandbox-build" || part === ".wrangler")) return true
  if (file === "scripts/sandbox/live" || file.startsWith("scripts/sandbox/live/")) return true
  if (/^(src|scripts)\/.*\/package(?:-lock)?\.json$/.test(file)) return true
  if (/^(src|scripts)\/.*\/Dockerfile$/.test(file)) return true
  return [
    "dist/",
    "dist-worker/",
    ".turbo/",
    "test-results/",
    "coverage/",
    "build/",
  ].some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix))
}

export async function packageFiles() {
  const output = await Bun.$`npm pack --dry-run --json`.quiet().text()
  const packs = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>
  return packs.flatMap((pack) => pack.files ?? []).flatMap((file) => (file.path ? [file.path] : []))
}

async function main() {
  const files = await packageFiles()
  const forbidden = files.filter((file) => forbiddenPackagePath(file))

  if (forbidden.length > 0) {
    console.error("Package boundary includes files that must never ship:")
    for (const file of forbidden) console.error(`- ${file}`)
    process.exit(1)
  }

  console.log(`Package boundary guard passed (${files.length} files checked).`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
