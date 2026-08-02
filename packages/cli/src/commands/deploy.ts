import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline/promises"

/**
 * `claxedo deploy` — self-host the control plane, end to end.
 *
 * Asks the few real questions (harness, tool placement, platform), derives
 * everything else from the platform constraint matrix, orchestrates the
 * platform's own CLI (flyctl v1 — never reimplements its API), and is only
 * "done" when the deployed instance answers its health check.
 *
 * v1 expects to run from a clone of the Claxedo monorepo (self-host-from-
 * source); the prebuilt-image path lands with the GHCR publish.
 */

type DeployOptions = {
  generateOnly: boolean
  yes: boolean
  app?: string
  region?: string
  harness?: string
  tools?: string
}

type SelectChoice = {
  value: string
  label: string
  hint?: string
  disabledReason?: string
}

const HARNESSES = ["pi", "opencode", "claude-code"]

const TOOL_CHOICES: SelectChoice[] = [
  {
    value: "this-server",
    label: "This server",
    hint: "tool processes on the same machine — simplest, no extra accounts; agent workloads share the machine",
  },
  {
    value: "daytona",
    label: "Daytona",
    hint: "fresh isolated container per session — needs a Daytona API key",
  },
  {
    value: "cloudflare",
    label: "Cloudflare sandboxes",
    hint: "containers on your CF account — needs CF API token + sandbox worker URL",
  },
]

const PLATFORM_CHOICES: SelectChoice[] = [
  { value: "fly", label: "Fly.io", hint: "always-on server with a disk; fits everything (recommended)" },
  { value: "railway", label: "Railway", disabledReason: "same model as Fly — adapter not shipped yet" },
  { value: "render", label: "Render", disabledReason: "same model as Fly — adapter not shipped yet" },
  {
    value: "cloudflare",
    label: "Cloudflare",
    disabledReason:
      "runs code in short-lived isolates without a disk or long-lived process; can't host the embedded engine or hold session connections open (yet)",
  },
  {
    value: "vercel",
    label: "Vercel",
    disabledReason:
      "serverless: functions have a max runtime and no persistent disk, so long-running sessions get cut on a timer",
  },
]

function parse(args: string[]): DeployOptions {
  const options: DeployOptions = { generateOnly: false, yes: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--generate-only") options.generateOnly = true
    else if (arg === "--yes" || arg === "-y") options.yes = true
    else if (arg === "--app") (options.app = args[i + 1]), (i += 1)
    else if (arg?.startsWith("--app=")) options.app = arg.slice("--app=".length)
    else if (arg === "--region") (options.region = args[i + 1]), (i += 1)
    else if (arg?.startsWith("--region=")) options.region = arg.slice("--region=".length)
    else if (arg === "--harness") (options.harness = args[i + 1]), (i += 1)
    else if (arg?.startsWith("--harness=")) options.harness = arg.slice("--harness=".length)
    else if (arg === "--tools") (options.tools = args[i + 1]), (i += 1)
    else if (arg?.startsWith("--tools=")) options.tools = arg.slice("--tools=".length)
  }
  return options
}

function findMonorepoRoot(start: string): string | undefined {
  let dir = start
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(dir, "packages/claxedo-server/Dockerfile"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

async function ask(rl: readline.Interface, question: string, fallback: string): Promise<string> {
  const answer = (await rl.question(`${question} [${fallback}]: `)).trim()
  return answer || fallback
}

async function select(rl: readline.Interface, title: string, choices: SelectChoice[], fallback: string): Promise<string> {
  console.log(`\n${title}`)
  const selectable = choices.filter((c) => !c.disabledReason)
  for (const [index, choice] of choices.entries()) {
    if (choice.disabledReason) {
      console.log(`     x ${choice.label} — ${choice.disabledReason}`)
    } else {
      const marker = choice.value === fallback ? "*" : " "
      console.log(`  ${marker} ${selectable.indexOf(choice) + 1}) ${choice.label}${choice.hint ? ` — ${choice.hint}` : ""}`)
    }
  }
  const raw = (await rl.question(`Choose 1-${selectable.length} [${fallback}]: `)).trim()
  if (!raw) return fallback
  const byNumber = selectable[Number.parseInt(raw, 10) - 1]
  if (byNumber) return byNumber.value
  const byValue = selectable.find((c) => c.value === raw)
  if (byValue) return byValue.value
  const disabled = choices.find((c) => c.value === raw && c.disabledReason)
  if (disabled) {
    console.log(`  ${disabled.label} isn't available: ${disabled.disabledReason}`)
    return select(rl, title, choices, fallback)
  }
  console.log("  Unrecognized choice, try again.")
  return select(rl, title, choices, fallback)
}

function run(command: string, args: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    let out = ""
    child.stdout?.on("data", (chunk) => {
      out += String(chunk)
      process.stdout.write(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      out += String(chunk)
      process.stderr.write(chunk)
    })
    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin)
      child.stdin?.end()
    }
    child.on("close", (code) => resolve({ code: code ?? 1, out }))
    child.on("error", () => resolve({ code: 127, out }))
  })
}

async function quiet(command: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout?.on("data", (chunk) => (out += String(chunk)))
    child.stderr?.on("data", (chunk) => (out += String(chunk)))
    child.on("close", (code) => resolve({ code: code ?? 1, out }))
    child.on("error", () => resolve({ code: 127, out }))
  })
}

function generatedConfig(input: { app: string; region: string }): string {
  return `# Generated by \`claxedo deploy\`. Safe to edit and re-deploy with:
#   fly deploy -c ${input.app}.fly.toml
app = "${input.app}"
primary_region = "${input.region}"

[build]
  dockerfile = "packages/claxedo-server/Dockerfile"

[env]
  CLAXEDO_SERVER_HOST = "0.0.0.0"
  CLAXEDO_SERVER_PORT = "3001"
  CLAXEDO_DATA_DIR = "/data"

[mounts]
  source = "claxedo_data"
  destination = "/data"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "45s"
    method = "GET"
    path = "/api/claxedo/health"

[[vm]]
  size = "shared-cpu-2x"
  # 4GB: the embedded engine (node-embed) OOMs a 2GB machine on first load.
  memory = "4gb"
`
}

async function pollHealth(url: string, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (res.ok) return true
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  return false
}

export async function deploy(args: string[]) {
  const options = parse(args)
  const root = findMonorepoRoot(process.cwd())
  if (!root) {
    throw new Error(
      "claxedo deploy (v1) must run inside a clone of the Claxedo monorepo — packages/claxedo-server/Dockerfile not found upward from here.",
    )
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const harness =
      options.harness && HARNESSES.includes(options.harness)
        ? options.harness
        : options.yes
          ? "pi"
          : await select(
              rl,
              "Which harness will you run?",
              HARNESSES.map((h) => ({ value: h, label: h })),
              "pi",
            )

    // Only pi supports split tool execution (tools-only session env seam);
    // other harnesses run brain+hands as one piece on the server.
    let tools = "this-server"
    if (harness === "pi") {
      tools =
        options.tools && TOOL_CHOICES.some((c) => c.value === options.tools)
          ? options.tools
          : options.yes
            ? "this-server"
            : await select(
                rl,
                "Where should tools execute? (the session itself runs on your server; this chooses where its commands run)",
                TOOL_CHOICES,
                "this-server",
              )
    }

    const platform = options.yes ? "fly" : await select(rl, "Deploy where?", PLATFORM_CHOICES, "fly")
    if (platform !== "fly") throw new Error(`platform "${platform}" is not available in v1`)

    const app = options.app ?? (options.yes ? "claxedo-selfhost" : await ask(rl, "App name (globally unique on Fly)", "claxedo-selfhost"))
    const region = options.region ?? (options.yes ? "sin" : await ask(rl, "Fly region", "sin"))

    const secrets: Record<string, string> = {}
    if (tools === "daytona") {
      secrets.DAYTONA_API_KEY = await ask(rl, "Daytona API key (stored as a Fly secret)", "")
      if (!secrets.DAYTONA_API_KEY) throw new Error("Daytona tool execution needs a Daytona API key")
    }
    if (tools === "cloudflare") {
      secrets.CLOUDFLARE_API_TOKEN = await ask(rl, "Cloudflare API token (stored as a Fly secret)", "")
      secrets.CLOUDFLARE_SANDBOX_WORKER_URL = await ask(rl, "Cloudflare sandbox worker URL", "")
      if (!secrets.CLOUDFLARE_API_TOKEN || !secrets.CLOUDFLARE_SANDBOX_WORKER_URL) {
        throw new Error("Cloudflare tool execution needs both the API token and the sandbox worker URL")
      }
    }

    const configPath = path.join(root, `${app}.fly.toml`)
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, generatedConfig({ app, region }))
    console.log(`\nWrote ${path.relative(process.cwd(), configPath)}`)

    if (options.generateOnly) {
      console.log(`\nGenerate-only. To deploy manually, from ${root}:`)
      console.log(`  fly apps create ${app}`)
      console.log(`  fly volumes create claxedo_data --app ${app} --region ${region} --size 10 --yes`)
      for (const key of Object.keys(secrets)) console.log(`  fly secrets set ${key}=... --app ${app} --stage`)
      console.log(`  fly deploy -c ${path.basename(configPath)} --remote-only`)
      console.log(`  open https://${app}.fly.dev`)
      return
    }

    // Stage 1: platform CLI present + logged in (the platform CLI owns auth).
    const version = await quiet("flyctl", ["version"])
    if (version.code !== 0) {
      throw new Error("flyctl not found. Install it: https://fly.io/docs/flyctl/install/ then run `fly auth login`.")
    }
    const who = await quiet("flyctl", ["auth", "whoami"])
    if (who.code !== 0) throw new Error("flyctl is not logged in. Run `fly auth login` and retry.")
    console.log(`\nDeploying as ${who.out.trim()} → app "${app}" (${region})`)

    // Stage 2: app + volume (idempotent — "already exists" is fine).
    const created = await quiet("flyctl", ["apps", "create", app])
    if (created.code !== 0 && !/already|taken/i.test(created.out)) {
      throw new Error(`stage "apps create" failed:\n${created.out}`)
    }
    const volumes = await quiet("flyctl", ["volumes", "list", "--app", app])
    if (!volumes.out.includes("claxedo_data")) {
      const volume = await run("flyctl", ["volumes", "create", "claxedo_data", "--app", app, "--region", region, "--size", "10", "--yes"])
      if (volume.code !== 0) throw new Error(`stage "volumes create" failed (see output above)`)
    }

    // Stage 3: secrets required by the chosen tool placement (never model keys
    // — those are configured in-app after first login).
    const secretEntries = Object.entries(secrets)
    if (secretEntries.length > 0) {
      const staged = await quiet("flyctl", [
        "secrets",
        "set",
        ...secretEntries.map(([key, value]) => `${key}=${value}`),
        "--app",
        app,
        "--stage",
      ])
      if (staged.code !== 0) throw new Error(`stage "secrets set" failed:\n${staged.out}`)
    }

    // Stage 4: deploy (remote builder — no local Docker needed).
    const deployed = await run("flyctl", ["deploy", "-c", configPath, "--remote-only"], { cwd: root })
    if (deployed.code !== 0) {
      throw new Error(`stage "deploy" failed — inspect with: fly logs --app ${app}`)
    }

    // Stage 5: deployed means VERIFIED, not "commands ran".
    const url = `https://${app}.fly.dev`
    console.log(`\nWaiting for health at ${url}/api/claxedo/health ...`)
    const healthy = await pollHealth(`${url}/api/claxedo/health`, 36)
    if (!healthy) {
      throw new Error(`deploy finished but health never went green — inspect with: fly logs --app ${app}`)
    }

    console.log(`\n✓ ${url} is up and healthy.`)
    // TODO(built-in auth): once the embedded Better Auth lands, deploys are
    // signed-by-default and this warning goes away.
    console.log(
      `\nWARNING: this instance currently runs WITHOUT authentication (built-in\n` +
        `accounts are not shipped yet). Anyone with the URL can use it. Keep it\n` +
        `private (Fly private networking / destroy after testing); do not treat\n` +
        `it as production until sign-in ships.`,
    )
    if (tools === "this-server") {
      console.log(`Tool execution: on the server itself (no per-session sandboxing in this mode).`)
    }
  } finally {
    rl.close()
  }
}
