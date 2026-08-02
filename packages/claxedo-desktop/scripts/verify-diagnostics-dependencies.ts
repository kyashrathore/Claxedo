import { resolve } from "node:path"

export const acceptedDiagnosticsDependencies = {
  pidusage: {
    version: "4.0.1",
    license: "MIT",
    integrity: "sha512-yCH2dtLHfEBnzlHUJymR/Z1nN2ePG3m392Mv8TFlTP1B0xkpMQNHAnfkY0n2tAi6ceKO6YWhxYfZ96V4vVkh/g==",
    native: false,
    manifest: "packages/claxedo-desktop/node_modules/pidusage/package.json",
  },
  pidtree: {
    version: "1.0.0",
    license: "MIT",
    integrity: "sha512-avfAvjB9Dd0wdj3rjJX//yS+G79OO0KrS5pJHFJENjYGX6N4SMgEDBBI/yFy0lloOYSaC6XQxzpOAMPfSYFV/Q==",
    native: false,
    manifest: "packages/claxedo-desktop/node_modules/pidtree/package.json",
  },
  "@vscode/windows-process-tree": {
    version: "0.8.0",
    license: "MIT",
    integrity: "sha512-TI+h2GRwX+igD/YYJMQQVAFcsCNSg7Te2yYxQpKMzwto5RsJ8d2KKgOeur/p/6sAOQwZvopiTDOClyTHEn9MhQ==",
    native: true,
    manifest: "packages/claxedo-desktop/node_modules/@vscode/windows-process-tree/package.json",
  },
} as const

export const acceptedDiagnosticsTransitives = {
  "safe-buffer": {
    version: "5.2.1",
    license: "MIT",
    integrity: "sha512-rp3So07KcdmmKbGvgaNxQSJr7bGVSVk5S9Eq1F+ppbRo70+YeaDxkw5Dd8NPN+GD6bjnYm2VuPuCXmpuYvmCXQ==",
    native: false,
    manifest: "node_modules/.bun/pidusage@4.0.1/node_modules/safe-buffer/package.json",
  },
  "node-addon-api": {
    version: "7.1.0",
    license: "MIT",
    integrity: "sha512-mNcltoe1R8o7STTegSOHdnJNN7s5EUvhoS7ShnTHDyOSd+8H+UdWODq6qSv67PjC8Zc5JRT8+oLAMCr0SIXw7g==",
    native: false,
    manifest:
      "node_modules/.bun/@vscode+windows-process-tree@0.8.0/node_modules/node-addon-api/package.json",
  },
} as const

export async function verifyDiagnosticsDependencies(
  root = resolve(import.meta.dirname, "../../.."),
  options: { advisories?: boolean } = {},
) {
  const desktop = await Bun.file(resolve(root, "packages/claxedo-desktop/package.json")).json()
  const workspace = await Bun.file(resolve(root, "package.json")).json()
  const lock = Bun.JSONC.parse(await Bun.file(resolve(root, "bun.lock")).text()) as {
    packages?: Record<string, unknown>
  }
  const direct = new Set(Object.keys(acceptedDiagnosticsDependencies))
  const results = await Promise.all(
    Object.entries({
      ...acceptedDiagnosticsDependencies,
      ...acceptedDiagnosticsTransitives,
    }).map(async ([name, accepted]) => {
      const manifest = await Bun.file(resolve(root, accepted.manifest)).json()
      const advisoryIds = options.advisories
        ? await queryAdvisories(name, accepted.version)
        : []
      const failures = [
        manifest.version !== accepted.version
          ? `${name} resolved ${String(manifest.version)} instead of ${accepted.version}`
          : undefined,
        manifest.license !== accepted.license
          ? `${name} license changed from ${accepted.license} to ${String(manifest.license)}`
          : undefined,
        direct.has(name) &&
        desktop.dependencies?.[name] !== accepted.version &&
        desktop.optionalDependencies?.[name] !== accepted.version
          ? `${name} is not exact-pinned in the desktop manifest`
          : undefined,
        !Object.values(lock.packages ?? {}).some((entry) =>
          Array.isArray(entry) &&
          entry[0] === `${name}@${accepted.version}` &&
          entry[3] === accepted.integrity)
          ? `${name} lock integrity does not match the reviewed tarball`
          : undefined,
        ["preinstall", "install", "postinstall"].find((script) => manifest.scripts?.[script])
          ? `${name} added an unreviewed lifecycle install script`
          : undefined,
        accepted.native && !workspace.trustedDependencies?.includes(name)
          ? `${name} is native but absent from trustedDependencies`
          : undefined,
        advisoryIds.length > 0
          ? `${name}@${accepted.version} has current advisories: ${advisoryIds.join(", ")}`
          : undefined,
      ].filter((item): item is string => !!item)
      return {
        name,
        version: accepted.version,
        license: accepted.license,
        integrity: accepted.integrity,
        native: accepted.native,
        direct: direct.has(name),
        advisoryIds,
        failures,
      }
    }),
  )
  return {
    dependencies: results,
    failures: results.flatMap((result) => result.failures),
  }
}

async function queryAdvisories(name: string, version: string) {
  const response = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { ecosystem: "npm", name }, version }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`OSV advisory query failed for ${name}@${version}: ${String(response.status)}`)
  const result = await response.json() as { vulns?: Array<{ id?: unknown }> }
  return (result.vulns ?? []).flatMap((vulnerability) =>
    typeof vulnerability.id === "string" ? [vulnerability.id] : [])
}

if (import.meta.main) {
  const report = await verifyDiagnosticsDependencies(undefined, {
    advisories: process.env.CLAXEDO_DIAGNOSTICS_VERIFY_ADVISORIES === "1",
  })
  console.log(JSON.stringify(report, null, 2))
  if (report.failures.length > 0) process.exit(1)
}
