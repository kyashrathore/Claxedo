import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { build, type Rollup } from "vite"
import { cloudConfig } from "./vite.cloud.config"

const LOGIN_HTML = fileURLToPath(new URL("./login.html", import.meta.url))
const APP = fileURLToPath(new URL("./src/", import.meta.url))

const OUTSIDE_THE_SIGNED_OUT_DOCUMENT = [
  /\/node_modules\/(@kobalte|@tanstack|@solidjs\/router|motion|marked|dompurify|shiki|@shikijs|@pierre|@xterm|solid-sonner|@corvu|@floating-ui)\//,
  new RegExp(`^${APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(shell|session|composer|transcript|workbench|rail|panel|review|files|tasks|terminal|marketplace|usage|projects|cloud|onboarding|plugins|accounts|access|browser)/`),
  new RegExp(`^${APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(app|main|registry)\\.tsx?$`),
  new RegExp(`^${APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}server/(server|transport|stream|sessions|workspaces)\\.ts$`),
  new RegExp(`^${APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}auth/view/(login-page|device-approval|oauth-consent)\\.tsx$`),
]

async function loginGraph() {
  const config = cloudConfig({ mode: "production", command: "build" }, "better-auth")
  const result = await build({
    ...config,
    configFile: false,
    logLevel: "silent",
    build: { ...config.build, write: false, minify: false, sourcemap: false, rollupOptions: { ...config.build?.rollupOptions, input: { login: LOGIN_HTML } } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => ("output" in output ? output.output : []))
  const chunks = new Map(outputs.filter((output): output is Rollup.OutputChunk => output.type === "chunk").map((chunk) => [chunk.fileName, chunk]))
  const entry = [...chunks.values()].find((chunk) => chunk.isEntry && chunk.name === "login")
  if (!entry) throw new Error("the build wrote no login entry")
  const reached = new Set<string>()
  const queue = [entry.fileName]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (reached.has(file)) continue
    reached.add(file)
    queue.push(...(chunks.get(file)?.imports ?? []))
  }
  const modules = [...reached].flatMap((file) => Object.entries(chunks.get(file)?.modules ?? {}).filter(([, module]) => module.renderedLength > 0).map(([id]) => id))
  return { files: [...reached], modules }
}

describe("the signed-out document's build", () => {
  test("its chunk graph holds the sign-in form, the account binding, the theme and the kit's icon, and nothing of the app behind the sign-in", async () => {
    const graph = await loginGraph()
    const outside = graph.modules.filter((id) => OUTSIDE_THE_SIGNED_OUT_DOCUMENT.some((pattern) => pattern.test(id)))
    expect(outside).toEqual([])
    const inside = ["/src/login.tsx", "/src/login-document.tsx", "/src/auth/view/login.tsx", "/src/auth/view/auth-split.tsx", "/src/auth/better-auth-binding.ts", "/src/ui/controls/claxedo-icon.tsx", "/ui/src/theme/context.tsx", "/node_modules/better-auth/", "/node_modules/solid-js/"]
    for (const marker of inside) expect(graph.modules.some((id) => id.includes(marker)), marker).toBe(true)
  }, 120_000)
})
