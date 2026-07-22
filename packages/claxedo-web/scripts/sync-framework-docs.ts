import { link, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

const source = path.resolve(import.meta.dir, "../../claxedo-docs")
const destination = path.resolve(import.meta.dir, "../src/content/docs/framework")
const check = process.argv.includes("--check")
const compatComponents = ["Note", "Warning", "Card", "CardGroup", "Steps", "Step", "CodeGroup", "ParamField", "ResponseField"] as const

const files = (await readdir(source, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
  .map((entry) => path.relative(source, path.join(entry.parentPath, entry.name)))
  .sort()

const transform = (relative: string, input: string) => {
  if (relative === "index.mdx") {
    const frontmatterEnd = input.indexOf("\n---", 4)
    if (frontmatterEnd < 0) throw new Error("Framework landing is missing frontmatter")
    return `${input.slice(0, frontmatterEnd + 4)}\n\nimport FrameworkHero from "../../../components/framework/FrameworkHero.astro"\n\n<FrameworkHero />\n`
  }

  const output = input
    .replace(/href="\/(?!framework(?:\/|"))/g, 'href="/framework/')
    .replace(/\]\(\/(?!framework(?:\/|\)))/g, "](/framework/")
  const used = compatComponents.filter((component) => output.includes(`<${component}`))
  if (used.length === 0) return output
  const frontmatterEnd = output.indexOf("\n---", 4)
  if (frontmatterEnd < 0) throw new Error(`Missing frontmatter in ${relative}`)
  const componentDirectory = path.join(import.meta.dir, "../src/components/framework/compat")
  const generatedDirectory = path.dirname(path.join(destination, relative))
  const imports = used.map((component) => {
    const modulePath = path.relative(generatedDirectory, path.join(componentDirectory, `${component}.astro`)).replaceAll(path.sep, "/")
    return `import ${component} from "${modulePath.startsWith(".") ? modulePath : `./${modulePath}`}"`
  })
  return `${output.slice(0, frontmatterEnd + 4)}\n\n${imports.join("\n")}\n${output.slice(frontmatterEnd + 4)}`
}

const expected = new Map(
  await Promise.all(
    files.map(async (relative) => [relative, transform(relative, await Bun.file(path.join(source, relative)).text())] as const),
  ),
)

if (check) {
  const generated = (await readdir(destination, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => path.relative(destination, path.join(entry.parentPath, entry.name)))
    .sort()
  if (generated.join("\n") !== files.join("\n")) throw new Error("Generated framework route inventory differs from source")
  for (const [relative, content] of expected) {
    if ((await Bun.file(path.join(destination, relative)).text()) !== content) throw new Error(`Generated framework content is stale: ${relative}`)
  }
  console.log(`Verified ${files.length} deterministic framework pages`)
  process.exit(0)
}

if (!destination.endsWith("/src/content/docs/framework")) throw new Error(`Refusing to replace unexpected path: ${destination}`)
const lockPath = `${destination}.sync.lock`
await acquireLock(lockPath)
const temporary = await mkdtemp(path.join(path.dirname(destination), ".framework-sync-"))
try {
  await Promise.all([...expected].map(async ([relative, content]) => {
    await mkdir(path.dirname(path.join(temporary, relative)), { recursive: true })
    await Bun.write(path.join(temporary, relative), content)
  }))
  await mkdir(destination, { recursive: true })
  const generated = (await readdir(destination, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => path.relative(destination, path.join(entry.parentPath, entry.name)))
  await Promise.all([...expected].map(async ([relative]) => {
    await mkdir(path.dirname(path.join(destination, relative)), { recursive: true })
    await rename(path.join(temporary, relative), path.join(destination, relative))
  }))
  await Promise.all(generated.filter((relative) => !expected.has(relative)).map((relative) => rm(path.join(destination, relative))))
} finally {
  await rm(lockPath, { force: true })
  await rm(temporary, { recursive: true, force: true })
}
console.log(`Synced ${files.length} framework pages`)

async function acquireLock(lockPath: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const candidate = `${lockPath}.${process.pid}.${crypto.randomUUID()}`
    await Bun.write(candidate, JSON.stringify({ pid: process.pid, createdAt: Date.now(), processStartedAt: Date.now() - process.uptime() * 1_000 }))
    try {
      await link(candidate, lockPath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      await rm(candidate, { force: true })
    }

    const metadata: unknown = await Bun.file(lockPath).json().catch(() => undefined)
    const details = await stat(lockPath).catch(() => undefined)
    const age = details ? Date.now() - details.mtimeMs : 0
    const owner = isLockMetadata(metadata) ? metadata : undefined
    if ((owner && (!processIsAlive(owner.pid) || age > 300_000)) || (!owner && age > 1_000)) {
      await rm(lockPath, { force: true })
      continue
    }
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for framework sync lock: ${lockPath}`)
}

function isLockMetadata(value: unknown): value is { pid: number; createdAt: number; processStartedAt: number } {
  if (!value || typeof value !== "object") return false
  const lock = value as Record<string, unknown>
  return Number.isInteger(lock.pid) && Number(lock.pid) > 0 && typeof lock.createdAt === "number" && typeof lock.processStartedAt === "number"
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}
