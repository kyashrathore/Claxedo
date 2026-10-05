import { join, normalize } from "node:path"

const root = join(import.meta.dir, "..")
const site = join(root, "..")
const transpiler = new Bun.Transpiler({ loader: "ts" })

const harnessMarks = async () => {
  const source = await Bun.file(join(site, "src/components/HarnessMark.astro")).text()
  const marks = Object.fromEntries(
    [...source.matchAll(/\{name === "(\w+)" && (<g[\s\S]*?<\/g>)\}/g)].map(([, name, body]) => [name, body]),
  )
  return `export const HARNESS_MARKS = ${JSON.stringify(marks)}`
}

const inside = (base, path) => {
  const file = normalize(join(base, path))
  return file.startsWith(base) ? file : undefined
}

const respond = async (pathname) => {
  if (pathname === "/" || pathname === "/index.html") return new Response(Bun.file(join(root, "index.html")))
  if (pathname === "/site/harness-marks.js") return js(await harnessMarks())
  const [base, rest] = pathname.startsWith("/site/") ? [site, pathname.slice(6)] : [root, pathname.slice(1)]
  if (base === site && !/^(src\/(icons|assets)|public)\//.test(rest)) return
  const path = inside(base, rest)
  if (!path) return
  const file = Bun.file(path)
  if (!(await file.exists())) return
  if (path.endsWith(".ts")) return js(transpiler.transformSync(await file.text()))
  return new Response(file)
}

const js = (code) => new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8" } })

export const serve = (port = 0) =>
  Bun.serve({
    port,
    async fetch(request) {
      return (await respond(new URL(request.url).pathname)) ?? new Response("Not found", { status: 404 })
    },
  })

if (import.meta.main) {
  const server = serve(Number(process.env.PORT ?? 4677))
  console.log(`Preview: ${server.url}?cut=film&play   (cuts: film, social, loop; ?t=12.5 holds a frame)`)
}
