type MigrationStatus = {
  name?: string
  state?: string
  isDone?: boolean
  error?: string
}

export function migrationStatusDecision(names: string[], statuses: unknown): boolean {
  if (!Array.isArray(statuses) || statuses.length !== names.length) {
    throw new Error(`Convex returned an incomplete migration status set: ${JSON.stringify(statuses)}`)
  }
  const typedStatuses = statuses as MigrationStatus[]
  const expectedNames = new Set(names)
  const returnedNames = new Set(typedStatuses.map((status) => status?.name))
  if (
    expectedNames.size !== names.length
    || returnedNames.size !== typedStatuses.length
    || [...expectedNames].some((name) => !returnedNames.has(name))
  ) {
    throw new Error(`Convex returned a mismatched migration status set: ${JSON.stringify(statuses)}`)
  }
  const failed = typedStatuses.find((status) => status?.state === "failed" || status?.state === "canceled")
  if (failed) {
    throw new Error(`Convex migration ${failed.name} ${failed.state}: ${failed.error ?? "no error detail"}`)
  }
  return typedStatuses.every((status) => status?.isDone === true && status?.state === "success")
}

export type MigrationWaitArgs = {
  names: string[]
  deploymentArgs: [] | ["--prod"] | ["--deployment", string]
}

export function parseMigrationWaitArgs(args: string[]): MigrationWaitArgs {
  const names: string[] = []
  let production = false
  let deployment: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--prod") {
      if (production || deployment) throw new Error("Choose exactly one Convex deployment selector")
      production = true
      continue
    }
    if (arg === "--deployment") {
      if (production || deployment) throw new Error("Choose exactly one Convex deployment selector")
      const value = args[index + 1]
      if (!value || value.startsWith("--") || /^migrations:/.test(value)) {
        throw new Error("--deployment requires a deployment name or reference")
      }
      deployment = value
      index += 1
      continue
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`)
    names.push(arg)
  }

  if (!names.length || names.some((name) => !/^migrations:[A-Za-z0-9_]+$/.test(name))) {
    throw new Error(
      "Usage: bun scripts/wait-for-convex-migrations.ts [--prod | --deployment <name>] migrations:name [...]",
    )
  }

  return {
    names,
    deploymentArgs: production ? ["--prod"] : deployment ? ["--deployment", deployment] : [],
  }
}

async function main() {
  const { names, deploymentArgs } = parseMigrationWaitArgs(process.argv.slice(2))

  const timeoutMs = Number(process.env.CONVEX_MIGRATION_WAIT_TIMEOUT_MS ?? 30 * 60 * 1000)
  const pollIntervalMs = Number(process.env.CONVEX_MIGRATION_POLL_INTERVAL_MS ?? 2_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Convex migration wait timing must be positive finite numbers")
  }

  const deadline = Date.now() + timeoutMs

  while (true) {
    const command = [
      "bunx",
      "convex",
      "run",
      "--component",
      "migrations",
      "lib:getStatus",
      JSON.stringify({ names }),
      ...deploymentArgs,
    ]
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(`Could not read Convex migration status: ${stderr.trim() || stdout.trim()}`)
    }

    let statuses: unknown
    try {
      statuses = JSON.parse(stdout)
    } catch {
      throw new Error(`Convex migration status was not JSON: ${stdout.trim()}`)
    }
    if (migrationStatusDecision(names, statuses)) {
      console.log(`Convex migrations complete: ${names.join(", ")}`)
      break
    }
    if (Date.now() >= deadline) {
      const summary = (statuses as MigrationStatus[])
        .map((status) => `${status?.name ?? "unknown"}:${status?.state ?? "invalid"}`)
        .join(", ")
      throw new Error(`Timed out waiting for Convex migrations: ${summary}`)
    }

    await Bun.sleep(pollIntervalMs)
  }
}

if (import.meta.main) await main()
