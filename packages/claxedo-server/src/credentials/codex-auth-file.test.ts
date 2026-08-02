import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, test } from "vitest"
import {
  codexAuthFileCandidates,
  mirrorCodexTokens,
  renewedCodexTokens,
  shouldMirrorCodexTokens,
} from "./codex-auth-file"

const roots: string[] = []

function home() {
  const root = path.join(os.tmpdir(), `codex-auth-${randomUUID().slice(0, 8)}`)
  mkdirSync(path.join(root, ".codex", "accounts"), { recursive: true })
  roots.push(root)
  return root
}

function authFile(file: string, accountId: string, access = "access_old", refresh = "refresh_old") {
  writeFileSync(
    file,
    JSON.stringify({
      type: "codex_auth",
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: "id_old", access_token: access, refresh_token: refresh, account_id: accountId },
      last_refresh: "2026-04-09T18:54:40.649142Z",
    }),
    { mode: 0o600 },
  )
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("shouldMirrorCodexTokens", () => {
  test("mirrors only imported Codex OAuth logins", () => {
    expect(shouldMirrorCodexTokens({ provider_id: "codex-acp", kind: "oauth_token", source: "local_only" })).toBe(true)
    expect(shouldMirrorCodexTokens({ provider_id: "codex-app-server", kind: "oauth_token", source: "local_only" }))
      .toBe(true)
  })

  test("leaves credentials that own no file on disk alone", () => {
    // Created inside Claxedo, not imported — there is nothing to mirror.
    expect(shouldMirrorCodexTokens({ provider_id: "codex-acp", kind: "oauth_token", source: "managed" })).toBe(false)
    expect(shouldMirrorCodexTokens({ provider_id: "codex-acp", kind: "api_key", source: "local_only" })).toBe(false)
    expect(shouldMirrorCodexTokens({ provider_id: "claude-acp", kind: "oauth_token", source: "local_only" }))
      .toBe(false)
  })
})

describe("renewedCodexTokens", () => {
  test("reads the renewed pair out of the stored secret", () => {
    const secret = JSON.stringify({
      tokens: { access_token: "access_new", refresh_token: "refresh_new", id_token: "id_new" },
      access: "access_new",
      refresh: "refresh_new",
    })
    expect(renewedCodexTokens(secret, "acct_1")).toEqual({
      accountId: "acct_1",
      access: "access_new",
      refresh: "refresh_new",
      idToken: "id_new",
    })
  })

  test("declines without an account id or a complete pair", () => {
    const secret = JSON.stringify({ access: "a", refresh: "r" })
    expect(renewedCodexTokens(secret, undefined)).toBeUndefined()
    expect(renewedCodexTokens(JSON.stringify({ access: "a" }), "acct_1")).toBeUndefined()
    expect(renewedCodexTokens("not json", "acct_1")).toBeUndefined()
  })
})

describe("mirrorCodexTokens", () => {
  test("rewrites the matching account file and leaves the others untouched", () => {
    const root = home()
    const mine = path.join(root, ".codex", "accounts", "user-a.auth.json")
    const other = path.join(root, ".codex", "accounts", "user-b.auth.json")
    authFile(mine, "acct_mine")
    authFile(other, "acct_other")

    const written = mirrorCodexTokens(
      { accountId: "acct_mine", access: "access_new", refresh: "refresh_new", idToken: "id_new" },
      root,
    )

    expect(written).toEqual([mine])
    const updated = JSON.parse(readFileSync(mine, "utf8")) as any
    expect(updated.tokens.access_token).toBe("access_new")
    expect(updated.tokens.refresh_token).toBe("refresh_new")
    expect(updated.tokens.id_token).toBe("id_new")
    expect(updated.tokens.account_id).toBe("acct_mine")
    expect(updated.auth_mode).toBe("chatgpt")
    expect(updated.last_refresh).not.toBe("2026-04-09T18:54:40.649142Z")
    expect(JSON.parse(readFileSync(other, "utf8"))).toMatchObject({
      tokens: { access_token: "access_old", refresh_token: "refresh_old" },
    })
  })

  test("mirrors the primary auth.json too", () => {
    const root = home()
    const primary = path.join(root, ".codex", "auth.json")
    authFile(primary, "acct_mine")

    expect(mirrorCodexTokens({ accountId: "acct_mine", access: "a2", refresh: "r2" }, root)).toEqual([primary])
  })

  test("keeps the existing id_token when the refresh returned none", () => {
    const root = home()
    const file = path.join(root, ".codex", "auth.json")
    authFile(file, "acct_mine")

    mirrorCodexTokens({ accountId: "acct_mine", access: "a2", refresh: "r2" }, root)

    expect((JSON.parse(readFileSync(file, "utf8")) as any).tokens.id_token).toBe("id_old")
  })

  test("never creates a file that was not already there", () => {
    const root = home()

    expect(mirrorCodexTokens({ accountId: "acct_missing", access: "a", refresh: "r" }, root)).toEqual([])
    expect(existsSync(path.join(root, ".codex", "auth.json"))).toBe(false)
  })

  test("is a no-op when the file already holds the same tokens", () => {
    const root = home()
    const file = path.join(root, ".codex", "auth.json")
    authFile(file, "acct_mine", "access_same", "refresh_same")

    expect(mirrorCodexTokens({ accountId: "acct_mine", access: "access_same", refresh: "refresh_same" }, root))
      .toEqual([])
  })

  test("writes atomically with owner-only permissions and leaves no temp file", () => {
    const root = home()
    const file = path.join(root, ".codex", "auth.json")
    authFile(file, "acct_mine")

    mirrorCodexTokens({ accountId: "acct_mine", access: "a2", refresh: "r2" }, root)

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(path.join(root, ".codex")).filter((entry) => entry.includes("tmp"))).toEqual([])
  })

  test("skips unreadable or non-Codex files instead of throwing", () => {
    const root = home()
    const broken = path.join(root, ".codex", "accounts", "broken.auth.json")
    writeFileSync(broken, "{ not json")

    expect(() => mirrorCodexTokens({ accountId: "acct_mine", access: "a", refresh: "r" }, root)).not.toThrow()
    expect(readFileSync(broken, "utf8")).toBe("{ not json")
  })
})

describe("codexAuthFileCandidates", () => {
  test("lists only existing files, primary first", () => {
    const root = home()
    const primary = path.join(root, ".codex", "auth.json")
    const account = path.join(root, ".codex", "accounts", "user-a.auth.json")
    authFile(primary, "acct_a")
    authFile(account, "acct_b")
    writeFileSync(path.join(root, ".codex", "accounts", "notes.txt"), "ignored")

    expect(codexAuthFileCandidates(root)).toEqual([primary, account])
  })
})
