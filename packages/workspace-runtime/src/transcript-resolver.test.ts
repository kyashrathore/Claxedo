import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTranscriptResolver } from "./transcript-resolver"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-transcript-"))
  roots.push(base)
  const providerRoot = path.join(base, "cursor", "sessions")
  await fs.mkdir(providerRoot, { recursive: true })
  const resolver = createTranscriptResolver({
    workspaceId: "workspace-a",
    providers: { "cursor-agent": { root: providerRoot, format: "jsonl" } },
    authorizeParent: ({ workspaceId, parentSessionId }) =>
      workspaceId === "workspace-a" && parentSessionId === "parent-a",
    createHandle: () => "transcript_opaque",
    maxBytes: 128,
    maxEntries: 3,
  })
  return { base, providerRoot, resolver }
}

describe("transcript resolver", () => {
  test("issues an opaque parent/workspace/provider-bound handle and resolves JSONL", async () => {
    const { providerRoot, resolver } = await fixture()
    const file = path.join(providerRoot, "agent-1.jsonl")
    await Bun.write(file, '{"type":"text","text":"hello"}\n')

    const registered = await resolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: file,
    })

    expect(registered).toEqual({ state: "ready", handle: "transcript_opaque" })
    expect(JSON.stringify(registered)).not.toContain(providerRoot)
    expect(await resolver.open({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      handle: "transcript_opaque",
    })).toEqual({ state: "ready", messages: [{ type: "text", text: "hello" }] })
    expect(await resolver.open({
      workspaceId: "workspace-b",
      parentSessionId: "parent-a",
      handle: "transcript_opaque",
    })).toMatchObject({ state: "unavailable" })
    expect(await resolver.open({
      workspaceId: "workspace-a",
      parentSessionId: "parent-b",
      handle: "transcript_opaque",
    })).toMatchObject({ state: "unavailable" })
  })

  test("rejects outside roots, sensitive subtrees, and symlink escapes", async () => {
    const { base, providerRoot, resolver } = await fixture()
    const outside = path.join(base, "outside.jsonl")
    await Bun.write(outside, "{}\n")
    expect(await resolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: outside,
    })).toMatchObject({ state: "unavailable" })

    const sensitive = path.join(providerRoot, "credentials", "session.jsonl")
    await fs.mkdir(path.dirname(sensitive), { recursive: true })
    await Bun.write(sensitive, "{}\n")
    expect(await resolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: sensitive,
    })).toMatchObject({ state: "unavailable" })

    const link = path.join(providerRoot, "escaped.jsonl")
    await fs.symlink(outside, link)
    expect(await resolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: link,
    })).toMatchObject({ state: "unavailable" })
  })

  test("fails closed when the file mutates, is oversized, malformed, or empty", async () => {
    const { providerRoot, resolver } = await fixture()
    const mutable = path.join(providerRoot, "mutable.jsonl")
    await Bun.write(mutable, '{"value":1}\n')
    expect(await resolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: mutable,
    })).toMatchObject({ state: "ready" })
    await Bun.write(mutable, '{"value":2}\n')
    expect(await resolver.open({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      handle: "transcript_opaque",
    })).toMatchObject({ state: "unavailable", reason: "mutated" })

    await Bun.write(path.join(providerRoot, "large.jsonl"), "x".repeat(129))
    expect(await resolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: path.join(providerRoot, "large.jsonl"),
    })).toMatchObject({ state: "unavailable", reason: "oversized" })

    const malformed = path.join(providerRoot, "malformed.jsonl")
    await Bun.write(malformed, '{"ok":true}\nnot-json\n')
    const malformedResolver = createTranscriptResolver({
      workspaceId: "workspace-a",
      providers: { "cursor-agent": { root: providerRoot, format: "jsonl" } },
      authorizeParent: () => true,
      createHandle: () => "malformed-handle",
    })
    await malformedResolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: malformed,
    })
    expect(await malformedResolver.open({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      handle: "malformed-handle",
    })).toMatchObject({ state: "unavailable", reason: "malformed" })

    const empty = path.join(providerRoot, "empty.jsonl")
    await Bun.write(empty, " \n")
    const emptyResolver = createTranscriptResolver({
      workspaceId: "workspace-a",
      providers: { "cursor-agent": { root: providerRoot, format: "jsonl" } },
      authorizeParent: () => true,
      createHandle: () => "empty-handle",
    })
    await emptyResolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: empty,
    })
    expect(await emptyResolver.open({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      handle: "empty-handle",
    })).toEqual({ state: "empty", messages: [] })
  })

  test("revalidates parent authorization at open and supports parent invalidation", async () => {
    const { providerRoot } = await fixture()
    let authorized = true
    const resolver = createTranscriptResolver({
      workspaceId: "workspace-a",
      providers: { "cursor-agent": { root: providerRoot, format: "jsonl" } },
      authorizeParent: () => authorized,
      createHandle: () => "revoked-handle",
    })
    const file = path.join(providerRoot, "revoked.jsonl")
    await Bun.write(file, "{}\n")
    await resolver.register({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      providerKind: "cursor-agent",
      filePath: file,
    })

    authorized = false
    expect(await resolver.open({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      handle: "revoked-handle",
    })).toMatchObject({ state: "unavailable", reason: "unauthorized" })
    resolver.invalidateParent("workspace-a", "parent-a")
    authorized = true
    expect(await resolver.open({
      workspaceId: "workspace-a",
      parentSessionId: "parent-a",
      handle: "revoked-handle",
    })).toMatchObject({ state: "unavailable", reason: "invalid-handle" })
  })
})
