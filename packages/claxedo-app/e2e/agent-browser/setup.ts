/**
 * Bootstrap: open the dev server, seed localStorage, navigate to a session URL.
 */
import { open, snapshot, waitFor, settle, close } from "./ab"

const BASE_URL = process.env.AB_BASE_URL ?? "http://localhost:4444"

/** Encode a directory path to the URL-safe base64 format the app uses. */
function encodeDir(dir: string): string {
  return Buffer.from(dir, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

export async function setup() {
  // Verify dev server is reachable.
  // We use curl because bun test preloads happydom which blocks cross-origin fetch.
  const check = Bun.spawnSync(["curl", "-sf", "-o", "/dev/null", BASE_URL])
  if (check.exitCode !== 0) {
    throw new Error(
      `Dev server not reachable at ${BASE_URL}. Start it with: bun run dev`,
    )
  }

  // Open the app
  await open(BASE_URL)
  await settle(3000)

  // Take initial snapshot to see what loaded
  const snap = await snapshot()

  // If we see a project list / home page, try to navigate to a workspace
  const workspaceDir =
    process.env.AB_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"
  const sessionUrl = `${BASE_URL}/${encodeDir(workspaceDir)}/session`

  if (!snap.includes("data-claxedo") && !snap.includes("terminal")) {
    await open(sessionUrl)
    await settle(3000)
  }

  return { baseUrl: BASE_URL, sessionUrl }
}

export async function teardown() {
  await close()
}
