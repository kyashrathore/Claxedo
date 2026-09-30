import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import type { PluginDiagnostic } from "./errors"
import type { PluginPackage } from "./manifest-file"

const DIAGNOSTIC_LINE = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const GLOBAL_DIAGNOSTIC_LINE = /^error (TS\d+): (.*)$/

const UNTYPED_HOST_MODULES = `declare module "@claxedo/app/ui"\ndeclare module "cloudflare:workers"\n`

const require = createRequire(import.meta.url)

/**
 * The compiler is TypeScript's native binary package for this platform, a
 * direct optional dependency of this package rather than something reached
 * through `typescript`: a packaged app stages it beside this code and ships
 * no `typescript` at all.
 */
const NATIVE_COMPILER_PACKAGE = `@typescript/typescript-${process.platform}-${process.arch}`

type CheckToolchain = Readonly<{ compiler: string; paths: Record<string, string[]> }>

function checkToolchain(): CheckToolchain {
  const native = path.dirname(require.resolve(`${NATIVE_COMPILER_PACKAGE}/package.json`))
  const solid = path.dirname(require.resolve("solid-js/package.json"))
  return {
    compiler: path.join(native, "lib", process.platform === "win32" ? "tsc.exe" : "tsc"),
    paths: {
      "solid-js": [path.join(solid, "types/index.d.ts")],
      "solid-js/web": [path.join(solid, "web/types/index.d.ts")],
      "solid-js/store": [path.join(solid, "store/types/index.d.ts")],
      "solid-js/jsx-runtime": [path.join(solid, "types/jsx.d.ts")],
      "@claxedo/plugin-api": [require.resolve("@claxedo/plugin-api")],
    },
  }
}

function typecheckConfig(rootDir: string, hostDeclarations: string, paths: CheckToolchain["paths"]) {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "preserve",
      jsxImportSource: "solid-js",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      isolatedModules: true,
      types: [],
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      paths,
    },
    files: [hostDeclarations],
    include: [path.join(rootDir, "**/*.ts"), path.join(rootDir, "**/*.tsx")],
    exclude: [path.join(rootDir, "node_modules"), path.join(rootDir, "dist")],
  }
}

function runCompiler(compiler: string, configPath: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(compiler, ["-p", configPath, "--pretty", "false"], { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code: code ?? 1, output }))
  })
}

export function parseCompilerOutput(output: string, rootDir: string): PluginDiagnostic[] {
  const diagnostics: { stage: "typecheck"; file?: string; line?: number; column?: number; code: string; message: string }[] = []
  for (const line of output.split(/\r?\n/)) {
    const located = DIAGNOSTIC_LINE.exec(line)
    if (located) {
      const [, file = "", row = "0", column = "0", code = "", message = ""] = located
      diagnostics.push({ stage: "typecheck", file: path.relative(rootDir, path.resolve(rootDir, file)), line: Number(row), column: Number(column), code, message })
      continue
    }
    const global = GLOBAL_DIAGNOSTIC_LINE.exec(line)
    if (global) {
      const [, code = "", message = ""] = global
      diagnostics.push({ stage: "typecheck", code, message })
      continue
    }
    const last = diagnostics.at(-1)
    if (last && /^\s+\S/.test(line)) last.message = `${last.message}\n${line.trim()}`
  }
  return diagnostics.filter((diagnostic) => diagnostic.file === undefined || !diagnostic.file.startsWith(".."))
}

export async function typecheckPlugin(pkg: PluginPackage): Promise<PluginDiagnostic[]> {
  const toolchain = checkToolchain()
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-check-"))
  try {
    const hostDeclarations = path.join(scratch, "host-modules.d.ts")
    const configPath = path.join(scratch, "tsconfig.json")
    await fs.writeFile(hostDeclarations, UNTYPED_HOST_MODULES)
    await fs.writeFile(configPath, JSON.stringify(typecheckConfig(pkg.rootDir, hostDeclarations, toolchain.paths)))
    const { code, output } = await runCompiler(toolchain.compiler, configPath, pkg.rootDir)
    const diagnostics = parseCompilerOutput(output, pkg.rootDir)
    if (code !== 0 && diagnostics.length === 0) {
      return [{ stage: "typecheck", message: `The TypeScript compiler exited with code ${code}: ${output.trim() || "no output"}` }]
    }
    return diagnostics
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
