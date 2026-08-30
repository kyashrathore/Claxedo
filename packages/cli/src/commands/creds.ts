import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline/promises"

/**
 * `claxedo creds sync --remote <url>` — push local harness subscription
 * credentials to a REMOTE control plane (W3b).
 *
 * CONSENT MODEL (non-negotiable): nothing is read or sent without an explicit
 * per-provider yes. The command shows WHAT was found (provider + account —
 * never token material), WHERE it will be sent, and requires confirmation
 * (--yes skips only the final prompt, not the summary).
 *
 * v1 scope: the Codex subscription bundle (~/.codex/auth.json, chatgpt mode)
 * → provider `codex-app-server` on the remote credential registry. Claude/Gemini
 * discovery lands later.
 */

type CredsSyncOptions = {
  remote?: string
  token?: string
  yes: boolean
}

function parseArgs(args: string[]): CredsSyncOptions {
  const options: CredsSyncOptions = { yes: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--remote") options.remote = args[++i]
    else if (arg === "--token") options.token = args[++i]
    else if (arg === "--yes" || arg === "-y") options.yes = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

type CodexBundle = {
  auth_mode: string
  OPENAI_API_KEY: string | null
  tokens: { id_token?: string; access_token: string; refresh_token: string; account_id: string }
  last_refresh: string
}

async function readCodexBundle(): Promise<CodexBundle | undefined> {
  try {
    const raw = await readFile(path.join(os.homedir(), ".codex", "auth.json"), "utf8")
    const value = JSON.parse(raw) as Record<string, unknown>
    const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens as Record<string, unknown> : undefined
    const access = typeof tokens?.access_token === "string" ? tokens.access_token : undefined
    const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token : undefined
    const account = typeof tokens?.account_id === "string" ? tokens.account_id : undefined
    if (!access || !refresh || !account) return undefined
    if (value.auth_mode !== undefined && value.auth_mode !== "chatgpt") return undefined
    return {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: typeof value.OPENAI_API_KEY === "string" ? value.OPENAI_API_KEY : null,
      tokens: {
        ...(typeof tokens?.id_token === "string" ? { id_token: tokens.id_token } : {}),
        access_token: access,
        refresh_token: refresh,
        account_id: account,
      },
      last_refresh: typeof value.last_refresh === "string" ? value.last_refresh : new Date().toISOString(),
    }
  } catch {
    return undefined
  }
}

function jwtExpMs(token: string): number | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

export async function creds(args: string[]) {
  const [subcommand, ...rest] = args
  if (subcommand !== "sync") {
    throw new Error("Usage: claxedo creds sync --remote <url> [--token <credentials-token>] [--yes]")
  }
  const options = parseArgs(rest)
  if (!options.remote) throw new Error("Missing --remote <url> (e.g. https://my-instance.fly.dev)")
  const remote = options.remote.replace(/\/+$/, "")

  const bundle = await readCodexBundle()
  if (!bundle) {
    console.log("No Codex subscription credential found (~/.codex/auth.json, chatgpt mode). Nothing to sync.")
    return
  }

  console.log("Found local credentials:")
  console.log(`  provider:  codex-app-server (Codex / ChatGPT subscription)`)
  console.log(`  account:   ${bundle.tokens.account_id}`)
  console.log(`  refreshed: ${bundle.last_refresh}`)
  console.log("")
  console.log(`This will send the OAuth token bundle (access + refresh token) to:`)
  console.log(`  ${remote}/api/claxedo/credentials`)
  console.log("")
  console.log("The remote instance will be able to run model turns on your Codex")
  console.log("subscription and refresh the token. Revoke any time by deleting the")
  console.log("credential on the instance.")
  console.log("")

  if (!options.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question("Sync codex-app-server to this instance? [y/N] ")).trim().toLowerCase()
    rl.close()
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted; nothing sent.")
      return
    }
  }

  const expires = jwtExpMs(bundle.tokens.access_token)
  const response = await fetch(`${remote}/api/claxedo/credentials`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      provider_id: "codex-app-server",
      kind: "oauth_token",
      source: "managed",
      label: "Codex subscription (claxedo creds sync)",
      account_id: bundle.tokens.account_id,
      secret: JSON.stringify({
        source: "codex",
        type: "codex_auth",
        ...bundle,
        access: bundle.tokens.access_token,
        refresh: bundle.tokens.refresh_token,
        ...(expires ? { expires } : {}),
        oauth: {
          access: bundle.tokens.access_token,
          refresh: bundle.tokens.refresh_token,
          ...(expires ? { expires } : {}),
          account_id: bundle.tokens.account_id,
        },
      }),
      ...(expires ? { expires_at: expires } : {}),
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Sync failed: ${response.status} ${body.slice(0, 300)}`)
  }
  const result = await response.json().catch(() => undefined) as { credential?: { id?: string; provider_id?: string } } | undefined
  console.log(`Synced codex-app-server → ${remote} (credential ${result?.credential?.id ?? "stored"}).`)
}
