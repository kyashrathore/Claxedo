import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { isolatedEnv } from "../../../harness/e2e/harness/isolated-env"
import { REPO_ROOT, TSX_LOADER } from "../../../harness/e2e/harness/node-loader"
import { APP_AGENT_ENV } from "./agent-env"
import type { Stack } from "./stack"

const run = promisify(execFile)

export async function saveTeamAccount(stack: Stack) {
  const registry = pathToFileURL(path.join(REPO_ROOT, "packages/claxedo-server-core/src/credentials/registry.ts")).href
  const code = `
    const { putCredential } = await import(${JSON.stringify(registry)});
    const account = await putCredential({ owner: null, provider_id: "claude-sdk", kind: "api_key", source: "managed", label: "Saved Claude account", secret: "fixture-team-key" }, "__local__");
    console.log("saved-team-account=" + account.id);
  `
  const { stdout } = await run(process.execPath, ["--conditions=development", "--import", TSX_LOADER, "--input-type=module", "-e", code], {
    cwd: REPO_ROOT,
    env: { ...(await isolatedEnv(stack.dataDir, stack.egress.url, APP_AGENT_ENV)), CLAXEDO_DATA_DIR: stack.dataDir },
  })
  const id = /^saved-team-account=(.+)$/m.exec(stdout)?.[1]
  if (!id) throw new Error("Credential registry did not report the saved account")
  return id
}
