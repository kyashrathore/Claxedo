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

export async function loadCursorDescriptors(): Promise<CursorDescriptors> {
  const sdkFile = fileURLToPath(import.meta.resolve("@cursor/sdk"))
  const sdkDir = path.dirname(sdkFile)
  const packageDir = path.resolve(sdkDir, "../..")
  const manifest = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as { version: string }
  if (manifest.version !== "1.0.24") throw new Error(`Cursor descriptors require SDK 1.0.24, found ${manifest.version}`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-cursor-descriptors-"))
  try {
    await fs.mkdir(path.join(dir, "dist", "esm"), { recursive: true })
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }))
    await fs.symlink(path.resolve(packageDir, "../.."), path.join(dir, "node_modules"))
    for (const name of await fs.readdir(sdkDir)) {
      if (!name.endsWith(".js")) continue
      const source = path.join(sdkDir, name)
      const destination = path.join(dir, "dist", "esm", name)
      if (name === "index.js") {
        let code = await fs.readFile(source, "utf8")
        if (!code.includes("G.m=D")) throw new Error("Pinned Cursor SDK module loader changed")
        const additions = [
          ["n.d(t,{EV:()=>Mh,", "n.d(t,{__serverConfig:()=>Jh,__bidi:()=>d,EV:()=>Mh,"],
          ["n.d(t,{rd:()=>U,", "n.d(t,{__analytics:()=>M,rd:()=>U,"],
        ] as const
        for (const [needle, replacement] of additions) {
          if (code.split(needle).length !== 2) throw new Error(`Pinned Cursor SDK descriptor location changed: ${needle}`)
          code = code.replace(needle, replacement)
        }
        await fs.writeFile(destination, `${code}\nexport const cursorInternalModule = G;\n`)
      } else {
        await fs.copyFile(source, destination)
      }
    }
    const sdk = await import(pathToFileURL(path.join(dir, "dist", "esm", "index.js")).href) as {
      cursorInternalModule(name: string): WebpackModule
    }
    const module = (name: string) => sdk.cursorInternalModule(name)
    return {
      service(name) {
        if (name === "aiserver/v1/server-config" || name === "aiserver/v1/bidi") {
          const exports = module("./src/agent/executor-common.ts")
          return exports[name === "aiserver/v1/bidi" ? "__bidi" : "__serverConfig"] as Service
        }
        if (name === "aiserver/v1/analytics") {
          return module("./src/agent/analytics.ts").__analytics as Service
        }
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
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true })
    throw error
  }
}
