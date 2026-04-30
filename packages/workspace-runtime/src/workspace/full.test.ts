import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { materializeCodexAuth, runtimeAuthKey } from "./full"

const tempDirs: string[] = []
const originalHome = process.env.HOME

function codexAuth(input?: { openaiKey?: string }) {
  return JSON.stringify({
    type: "codex_auth",
    auth_mode: "chatgpt",
    ...(input?.openaiKey ? { OPENAI_API_KEY: input.openaiKey } : {}),
    tokens: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      account_id: "account-id",
      id_token: "id-token",
    },
    oauth: {
      access: "oauth-access",
      refresh: "oauth-refresh",
      account_id: "oauth-account",
    },
    last_refresh: "2026-04-22T00:00:00.000Z",
  })
}

function codexAccountAuth() {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "account-access-token",
      refresh_token: "account-refresh-token",
      account_id: "account-id",
      id_token: "account-id-token",
    },
    last_refresh: "2026-04-22T00:00:00.000Z",
  })
}

afterEach(async () => {
  process.env.HOME = originalHome
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe("workspace full runtime auth helpers", () => {
  test("runtimeAuthKey passes through raw api keys", () => {
    expect(runtimeAuthKey("sk-openai-direct")).toBe("sk-openai-direct")
  })

  test("runtimeAuthKey extracts OPENAI_API_KEY from codex_auth bundles", () => {
    expect(runtimeAuthKey(codexAuth({ openaiKey: "sk-openai-bundled" }))).toBe("sk-openai-bundled")
  })

  test("runtimeAuthKey does not expose token-only codex_auth bundles as api keys", () => {
    expect(runtimeAuthKey(codexAuth())).toBeUndefined()
  })

  test("runtimeAuthKey ignores raw codex account bundles without OPENAI_API_KEY", () => {
    expect(runtimeAuthKey(codexAccountAuth())).toBeUndefined()
  })

  test("materializeCodexAuth writes a codex auth file for token bundles", async () => {
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    const mkdirCalls: Array<{ target: string; mode?: number }> = []
    const writeCalls: Array<{ target: string; body: string; mode?: number }> = []

    fs.promises.mkdir = (async (target: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
      mkdirCalls.push({ target: String(target), mode: options?.mode as number | undefined })
      return undefined as never
    }) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async (target: fs.PathLike, body: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      writeCalls.push({
        target: String(target),
        body: typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"),
        mode: typeof options === "object" && options ? options.mode as number | undefined : undefined,
      })
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      await materializeCodexAuth(codexAuth())

      expect(mkdirCalls).toHaveLength(1)
      expect(mkdirCalls[0]).toMatchObject({
        target: path.join(os.homedir(), ".codex"),
        mode: 0o700,
      })
      expect(writeCalls).toHaveLength(1)
      expect(writeCalls[0]?.target).toBe(path.join(os.homedir(), ".codex", "auth.json"))
      expect(writeCalls[0]?.mode).toBe(0o600)

      const data = JSON.parse(writeCalls[0]!.body) as {
        auth_mode: string
        OPENAI_API_KEY: string | null
        tokens: Record<string, string>
      }

      expect(data.auth_mode).toBe("chatgpt")
      expect(data.OPENAI_API_KEY).toBeNull()
      expect(data.tokens).toMatchObject({
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "account-id",
        id_token: "id-token",
      })
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })

  test("materializeCodexAuth accepts token bundles supplied through an alias slot", async () => {
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    const writeCalls: string[] = []

    fs.promises.mkdir = (async () => undefined as never) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async (_target: fs.PathLike, body: string | NodeJS.ArrayBufferView) => {
      writeCalls.push(typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"))
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      await materializeCodexAuth(codexAuth())
      expect(writeCalls).toHaveLength(1)
      expect(JSON.parse(writeCalls[0]!).tokens.account_id).toBe("account-id")
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })

  test("materializeCodexAuth accepts raw codex account bundles", async () => {
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    const writeCalls: string[] = []

    fs.promises.mkdir = (async () => undefined as never) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async (_target: fs.PathLike, body: string | NodeJS.ArrayBufferView) => {
      writeCalls.push(typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"))
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      await materializeCodexAuth(codexAccountAuth())
      expect(writeCalls).toHaveLength(1)
      const data = JSON.parse(writeCalls[0]!)
      expect(data.tokens.access_token).toBe("account-access-token")
      expect(data.tokens.account_id).toBe("account-id")
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })
})
