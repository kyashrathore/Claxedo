import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

type MessageType = {
  typeName: string
  fromBinary(bytes: Uint8Array): { toJson(options?: object): unknown }
  fromJson(value: unknown): { toBinary(): Uint8Array }
}

type Method = { name: string; I: MessageType; O: MessageType; kind: number }
type Service = { typeName: string; methods: Record<string, Method> }
type WebpackModule = Record<string, unknown>

export type CursorDescriptors = {
  service(name: string): Service
  message(moduleName: string, typeName: string): MessageType
  close(): Promise<void>
}

const HARNESS_MANIFEST = path.resolve(import.meta.dirname, "../../../package.json")

const HIDDEN_SERVICES = [
  { exportName: "__serverConfig", module: "./src/agent/executor-common.ts", typeName: "aiserver.v1.ServerConfigService" },
  { exportName: "__bidi", module: "./src/agent/executor-common.ts", typeName: "aiserver.v1.BidiService" },
  { exportName: "__analytics", module: "./src/agent/analytics.ts", typeName: "aiserver.v1.AnalyticsService" },
] as const

async function pinnedVersion(): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(HARNESS_MANIFEST, "utf8")) as { dependencies?: Record<string, string> }
  const version = manifest.dependencies?.["@cursor/sdk"]
  if (!version) throw new Error("packages/harness does not pin @cursor/sdk")
  return version
}

async function sdkPackageDir(): Promise<string> {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@cursor/sdk"))), "../..")
  const manifest = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as { name: string; version: string }
  const pinned = await pinnedVersion()
  if (manifest.name !== "@cursor/sdk" || manifest.version !== pinned) {
    throw new Error(`Cursor descriptors require @cursor/sdk ${pinned}, found ${manifest.name} ${manifest.version}`)
  }
  return packageDir
}

function only(code: string, pattern: RegExp, what: string): RegExpMatchArray {
  const matches = [...code.matchAll(pattern)]
  const [match] = matches
  if (!match || matches.length !== 1) throw new Error(`Pinned Cursor SDK layout changed: ${matches.length} matches for ${what}`)
  return match
}

function escaped(value: string): string {
  return value.replaceAll(".", "\\.")
}

function moduleBody(code: string, module: string): { start: number; end: number } {
  const header = only(code, new RegExp(`"${escaped(module)}"\\(\\w,\\w,(\\w)\\)\\{\\1\\.d\\(\\w,\\{`, "g"), `module ${module}`)
  const start = header.index! + header[0].length
  const next = /"\.{1,2}\/[^"]+"\(\w,\w,\w\)\{/g
  next.lastIndex = start
  return { start, end: next.exec(code)?.index ?? code.length }
}

function exposeHiddenServices(code: string): string {
  const additions = new Map<number, string[]>()
  for (const hidden of HIDDEN_SERVICES) {
    const body = moduleBody(code, hidden.module)
    const declaration = only(code, new RegExp(`const ([\\w$]+)=\\{typeName:"${escaped(hidden.typeName)}"`, "g"), hidden.typeName)
    if (declaration.index! < body.start || declaration.index! > body.end) {
      throw new Error(`Pinned Cursor SDK layout changed: ${hidden.typeName} is outside ${hidden.module}`)
    }
    additions.set(body.start, [...additions.get(body.start) ?? [], `${hidden.exportName}:()=>${declaration[1]},`])
  }
  let exposed = code
  for (const start of [...additions.keys()].sort((a, b) => b - a)) {
    exposed = `${exposed.slice(0, start)}${additions.get(start)!.join("")}${exposed.slice(start)}`
  }
  const loader = only(exposed, /\}([\w$]{1,3})\.m=[\w$]{1,3},/g, "the module loader")
  return `${exposed}\nexport const cursorInternalModule = ${loader[1]};\n`
}

async function stageSdk(dir: string, packageDir: string): Promise<void> {
  const sdkDir = path.join(packageDir, "dist", "esm")
  await fs.mkdir(path.join(dir, "dist", "esm"), { recursive: true })
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }))
  await fs.symlink(path.resolve(packageDir, "../.."), path.join(dir, "node_modules"))
  for (const name of await fs.readdir(sdkDir)) {
    if (!name.endsWith(".js")) continue
    const destination = path.join(dir, "dist", "esm", name)
    if (name === "index.js") await fs.writeFile(destination, exposeHiddenServices(await fs.readFile(path.join(sdkDir, name), "utf8")))
    else await fs.copyFile(path.join(sdkDir, name), destination)
  }
}

function descriptorsFrom(module: (name: string) => WebpackModule, dir: string): CursorDescriptors {
  return {
    service(name) {
      const hidden = { "aiserver/v1/server-config": HIDDEN_SERVICES[0], "aiserver/v1/bidi": HIDDEN_SERVICES[1], "aiserver/v1/analytics": HIDDEN_SERVICES[2] }[name]
      if (hidden) return module(hidden.module)[hidden.exportName] as Service
      const exports = module(`../proto/dist/generated/${name}_connect.js`)
      const service = Object.values(exports).find((value): value is Service =>
        typeof value === "object" && value !== null && "methods" in value && "typeName" in value)
      if (!service) throw new Error(`Cursor SDK has no service descriptor for ${name}`)
      return service
    },
    message(moduleName, typeName) {
      const exports = module(`../proto/dist/generated/${moduleName}_pb.js`)
      const message = Object.values(exports).find((value): value is MessageType =>
        typeof value === "function" && "typeName" in value && value.typeName === typeName)
      if (!message) throw new Error(`Cursor SDK has no message descriptor ${typeName}`)
      return message
    },
    close: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

export async function loadCursorDescriptors(): Promise<CursorDescriptors> {
  const packageDir = await sdkPackageDir()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-cursor-descriptors-"))
  try {
    await stageSdk(dir, packageDir)
    const sdk = await import(pathToFileURL(path.join(dir, "dist", "esm", "index.js")).href) as {
      cursorInternalModule(name: string): WebpackModule
    }
    return descriptorsFrom((name) => sdk.cursorInternalModule(name), dir)
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true })
    throw error
  }
}
