import { ensureD1Database } from "./d1-databases"
import { probeWrangler } from "./wrangler-cli"

const USAGE = "Usage: bun run d1:reset:staging -- --confirm <staging control-plane D1 name>"

export async function resetStagingD1(env: NodeJS.ProcessEnv, args: readonly string[]) {
  const name = env.CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME?.trim()
  if (!name) throw new Error("Set CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME to the staging control-plane D1 name")
  if (name === env.CLAXEDO_AUTH_D1_DATABASE_NAME?.trim()) throw new Error("Staging control-plane D1 must differ from AUTH_DB")
  if (args.length !== 2 || args[0] !== "--confirm") throw new Error(USAGE)
  if (args[1] !== name) throw new Error(`--confirm ${args[1]} does not name the configured staging control-plane D1 ${name}`)
  const deleted = await probeWrangler(["d1", "delete", name, "--skip-confirmation"])
  if (deleted.code !== 0) throw new Error(`Staging D1 deletion failed: ${deleted.stderr}`)
  const created = await ensureD1Database(name)
  if (!created.created) throw new Error(`Staging D1 ${name} still exists after deletion`)
  return created
}

if (import.meta.main) {
  const result = await resetStagingD1(process.env, process.argv.slice(2))
  console.log(`Staging control-plane D1 recreated as ${result.id}. Rerun the staging deploy to bind it and apply the baseline.`)
}
