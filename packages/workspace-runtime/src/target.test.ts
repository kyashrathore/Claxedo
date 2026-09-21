import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertTarget,
  authoritativeWorkspaceId,
  registerWorkspaceDirectory,
  registeredWorkspaceDirectoriesUnder,
  registeredWorkspaceDirectoryOwners,
  resolveWorkspaceCommandPaths,
  resolveWorkspacePath,
  unregisterWorkspaceDirectory,
  withWorkspaceTarget,
  workspaceDir,
  workspaceId,
} from "./target"

describe("workspaceDir", () => {
  it("rejects multi-directory configuration", () => {
    expect(() =>
      workspaceDir({ WORKSPACE_RUNTIME_DIRECTORY: "/tmp/a,/tmp/b" } as NodeJS.ProcessEnv)
    ).toThrow("WORKSPACE_RUNTIME_DIRECTORY must contain exactly one directory")
  })

  it("resolves a single configured directory", () => {
    expect(workspaceDir({ WORKSPACE_RUNTIME_DIRECTORY: "./tmp/demo" } as NodeJS.ProcessEnv)).toContain("/tmp/demo")
    expect(workspaceDir({ WORKSPACE_RUNTIME_DIRECTORY: "./tmp/demo" } as NodeJS.ProcessEnv)).toContain("/tmp/demo")
  })
})

describe("assertTarget", () => {
  it("accepts the configured directory", () => {
    expect(assertTarget("/tmp/demo", { WORKSPACE_RUNTIME_DIRECTORY: "/tmp/demo" } as NodeJS.ProcessEnv)).toBe("/tmp/demo")
  })

  it("accepts the configured synthetic workspace directory", () => {
    expect(assertTarget(
      "workspace:ws_123",
      {
        WORKSPACE_RUNTIME_DIRECTORY: "/tmp/demo",
        WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_123",
      } as NodeJS.ProcessEnv,
    )).toBe("/tmp/demo")
  })

  it("rejects mismatched directories", () => {
    expect(() =>
      assertTarget("/tmp/other", { WORKSPACE_RUNTIME_DIRECTORY: "/tmp/demo" } as NodeJS.ProcessEnv)
    ).toThrow("workspace-runtime is pinned to /tmp/demo")
  })
})

describe("resolveWorkspacePath", () => {
  it("keeps relative paths inside the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-target-"))
    try {
      await fs.mkdir(path.join(tmp, "src"))
      await fs.writeFile(path.join(tmp, "src", "index.ts"), "")

      expect(await resolveWorkspacePath(tmp, "src/index.ts")).toBe(path.join(tmp, "src", "index.ts"))
      await expect(resolveWorkspacePath(tmp, path.join(tmp, "src", "index.ts"))).rejects.toThrow("workspace path must be relative")
      await expect(resolveWorkspacePath(tmp, "../index.ts")).rejects.toThrow("workspace path escapes configured directory")
      await expect(resolveWorkspacePath(tmp, "bad\u0000path")).rejects.toThrow("workspace path cannot contain null bytes")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("trims by default and keeps the exact spelling on request", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-target-"))
    try {
      await fs.mkdir(path.join(tmp, " lead"))
      await fs.mkdir(path.join(tmp, "lead"))
      await fs.mkdir(path.join(tmp, "trail "))

      expect(await resolveWorkspacePath(tmp, " lead")).toBe(path.join(tmp, "lead"))
      expect(await resolveWorkspacePath(tmp, " lead", { exactInput: true })).toBe(path.join(tmp, " lead"))
      expect(await resolveWorkspacePath(tmp, "trail ", { exactInput: true })).toBe(path.join(tmp, "trail "))
      expect(await resolveWorkspacePath(tmp, " ", { exactInput: true })).toBe(path.join(tmp, " "))
      expect(await resolveWorkspacePath(tmp, " ")).toBe(path.resolve(tmp))
      await expect(resolveWorkspacePath(tmp, "../out ", { exactInput: true })).rejects.toThrow(
        "workspace path escapes configured directory",
      )
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("rejects symlink realpath escapes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-target-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-target-outside-"))
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "secret")
      await fs.symlink(outside, path.join(tmp, "linked-out"))

      await expect(resolveWorkspacePath(tmp, "linked-out/secret.txt")).rejects.toThrow(
        "workspace path escapes configured directory",
      )
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe("resolveWorkspaceCommandPaths", () => {
  it("allows workspace-relative paths and an absolute executable only", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-command-"))
    try {
      await fs.writeFile(path.join(tmp, "input.txt"), "input")
      await resolveWorkspaceCommandPaths(tmp, { command: "/bin/cat input.txt", allowAbsoluteExecutable: true })
      await expect(resolveWorkspaceCommandPaths(tmp, {
        command: "cat ~/.local/share/opencode/opencode.db",
        allowAbsoluteExecutable: true,
      })).rejects.toThrow("workspace command path must be relative")
      // An absolute path OUTSIDE the workspace is still rejected — the M0 RCE
      // (reading the global opencode DB) stays blocked by containment.
      await expect(resolveWorkspaceCommandPaths(tmp, {
        command: "cat",
        args: ["/tmp/outside"],
        allowAbsoluteExecutable: true,
      })).rejects.toThrow("workspace path escapes configured directory")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("permits an absolute path that resolves inside the workspace (hydrated docs)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-command-abs-"))
    try {
      const inside = path.join(tmp, "docs", "note.md")
      await fs.mkdir(path.dirname(inside), { recursive: true })
      await fs.writeFile(inside, "x")
      // The document-hydration bash form: `printf %b "..." > /abs/in/workspace`.
      await resolveWorkspaceCommandPaths(tmp, { command: `printf %b "hi" > ${JSON.stringify(inside)}` })
      // An arg that is an in-workspace absolute path is allowed too.
      await resolveWorkspaceCommandPaths(tmp, { command: "cat", args: [inside] })
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("still blocks a symlinked absolute path that escapes the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-command-esc-"))
    const secret = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-secret-"))
    try {
      await fs.writeFile(path.join(secret, "creds"), "x")
      const link = path.join(tmp, "escape")
      await fs.symlink(secret, link)
      await expect(resolveWorkspaceCommandPaths(tmp, {
        command: "cat",
        args: [path.join(link, "creds")],
      })).rejects.toThrow("workspace path escapes configured directory")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
      await fs.rm(secret, { recursive: true, force: true })
    }
  })

  it("checks paths glued to redirection operators", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-command-redir-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-redir-outside-"))
    try {
      const inner = path.join(tmp, "out.txt")
      const outer = path.join(outside, "out.txt")
      await fs.writeFile(inner, "x")
      await fs.writeFile(outer, "x")

      // Redirect targets inside the workspace pass however they are spelled.
      for (const command of [
        `printf hi>${JSON.stringify(inner)}`,
        `printf hi >>${inner}`,
        `cat<${inner}`,
        `cat 2>${inner}`,
        `cat&>${inner}`,
        `cat ${inner}>${inner}`,
        "printf hi>&2",
        "printf hi>rel.txt",
      ]) {
        await resolveWorkspaceCommandPaths(tmp, { command })
      }
      // The same spellings aimed outside the workspace are caught, including a
      // redirect glued onto an in-workspace path and command separators.
      for (const command of [
        `printf hi>${JSON.stringify(outer)}`,
        `printf hi>>${outer}`,
        `cat<${outer}`,
        `cat 2>${outer}`,
        `cat&>${outer}`,
        `cat ${inner}>${outer}`,
        `cat|${outer}`,
        `cat&${outer}`,
      ]) {
        await expect(resolveWorkspaceCommandPaths(tmp, { command })).rejects.toThrow(
          "workspace path escapes configured directory",
        )
      }
      // Home and env-expansion forms behind a redirect stay refused.
      for (const command of ["echo x>~/secret", "cat<$HOME/secret", "echo x>>${HOME}/secret"]) {
        await expect(resolveWorkspaceCommandPaths(tmp, { command })).rejects.toThrow(
          "workspace command path must be relative",
        )
      }
      await expect(resolveWorkspaceCommandPaths(tmp, {
        command: "cat",
        args: [`>${outer}`],
      })).rejects.toThrow("workspace path escapes configured directory")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe("registered worktree ownership", () => {
  it("names every owner of a path however it is spelled, and the worktrees a root walk reaches", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-owners-"))
    const env = { WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_owners" } as NodeJS.ProcessEnv
    const outer = path.join(tmp, "outer")
    const inner = path.join(outer, "inner")
    try {
      await fs.mkdir(inner, { recursive: true })
      await fs.writeFile(path.join(inner, "file.txt"), "")
      await fs.symlink(inner, path.join(tmp, "link"))
      registerWorkspaceDirectory({ workspaceId: "ws_owners", sessionId: "ses_outer", directory: outer })
      registerWorkspaceDirectory({ workspaceId: "ws_owners", sessionId: "ses_inner", directory: inner })

      expect(registeredWorkspaceDirectoryOwners(outer, env)).toEqual(["ses_outer"])
      expect(registeredWorkspaceDirectoryOwners(path.join(inner, "file.txt"), env).sort()).toEqual([
        "ses_inner",
        "ses_outer",
      ])
      // Same entry through a symlink and through a relative spelling.
      expect(registeredWorkspaceDirectoryOwners(path.join(tmp, "link", "file.txt"), env).sort()).toEqual([
        "ses_inner",
        "ses_outer",
      ])
      expect(registeredWorkspaceDirectoryOwners(path.join(outer, "..", "outer", "inner"), env).sort()).toEqual([
        "ses_inner",
        "ses_outer",
      ])
      // A leaf that does not exist yet is still placed by the real directory
      // that would hold it, link and all.
      expect(registeredWorkspaceDirectoryOwners(path.join(tmp, "link", "not-yet.txt"), env).sort()).toEqual([
        "ses_inner",
        "ses_outer",
      ])
      expect(registeredWorkspaceDirectoryOwners(tmp, env)).toEqual([])
      // A sibling whose name starts with a registered one is not inside it.
      expect(registeredWorkspaceDirectoryOwners(`${outer}-sibling`, env)).toEqual([])
      // A root that is not on disk at all answers, rather than raising: the
      // routes ask this before they find out the directory is missing.
      expect(registeredWorkspaceDirectoryOwners(path.join(tmp, "gone", "file.txt"), env)).toEqual([])
      expect(registeredWorkspaceDirectoriesUnder(path.join(tmp, "gone"), env)).toEqual([])

      // The other direction: what a recursive operation on a root reaches.
      expect(registeredWorkspaceDirectoriesUnder(tmp, env).map((entry) => entry.sessionId).sort()).toEqual([
        "ses_inner",
        "ses_outer",
      ])
      expect(registeredWorkspaceDirectoriesUnder(outer, env).map((entry) => entry.sessionId)).toEqual(["ses_inner"])
      // Through an alias of the same root, and through a root spelled with a link.
      expect(registeredWorkspaceDirectoriesUnder(path.join(tmp, "outer", "..", "outer"), env)
        .map((entry) => entry.sessionId)).toEqual(["ses_inner"])
      expect(registeredWorkspaceDirectoriesUnder(inner, env)).toEqual([])
    } finally {
      unregisterWorkspaceDirectory({ workspaceId: "ws_owners", sessionId: "ses_outer" })
      unregisterWorkspaceDirectory({ workspaceId: "ws_owners", sessionId: "ses_inner" })
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe("workspaceId", () => {
  it("stays stable for process env fallback", () => {
    const a = workspaceId()
    const b = workspaceId()
    expect(a).toBe(b)
  })

  it("prefers the configured id", () => {
    expect(workspaceId({ WORKSPACE_RUNTIME_WORKSPACE_ID: "wr_123" } as NodeJS.ProcessEnv)).toBe("wr_123")
    expect(workspaceId({ WORKSPACE_RUNTIME_WORKSPACE_ID: "wr_123" } as NodeJS.ProcessEnv)).toBe("wr_123")
  })
})

describe("authoritativeWorkspaceId", () => {
  it("reads the target this runtime was placed for", () => {
    withWorkspaceTarget({ workspaceId: "ws_placed", directory: "/tmp/placed" }, () => {
      expect(authoritativeWorkspaceId()).toBe("ws_placed")
    })
  })

  it("reads the configured id", () => {
    expect(authoritativeWorkspaceId({ WORKSPACE_RUNTIME_WORKSPACE_ID: "wr_123" } as NodeJS.ProcessEnv)).toBe("wr_123")
  })

  it("answers nothing rather than the id workspaceId mints", () => {
    const env = {} as NodeJS.ProcessEnv
    expect(authoritativeWorkspaceId(env)).toBeUndefined()
    expect(workspaceId(env)).toBeTruthy()
  })
})
