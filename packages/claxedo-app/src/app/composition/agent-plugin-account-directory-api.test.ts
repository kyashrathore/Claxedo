import { describe, expect, test } from "bun:test"
import type { AccountPort, HostedOperationName } from "@/platform/account/account-port"
import { DirectorySourceError } from "@/features/agent-plugins/directory/data"
import { accountDirectoryApi } from "./agent-plugin-account-directory-api"

const source = {
  id: "src_1",
  kind: "personal" as const,
  label: "acme/plugins",
  repository: "acme/plugins",
  ref: "main",
  canRemove: true,
}

function account(answer: (operation: HostedOperationName, input?: Record<string, unknown>) => unknown) {
  const calls: Array<{ operation: HostedOperationName; input?: Record<string, unknown> }> = []
  const port: AccountPort = {
    state: () => ({ status: "signed", identity: { userId: "user-1" } }),
    signIn: async () => {},
    signOut: async () => {},
    run: async (operation, input) => {
      calls.push({ operation, input })
      return answer(operation, input) as never
    },
  }
  return { port, calls }
}

describe("signed desktop Directory account client", () => {
  test("lists sources through the named operation", async () => {
    const subject = account(() => ({ status: 200, body: { sources: [source] } }))

    await expect(accountDirectoryApi(subject.port, async () => ({ harnesses: [] })).sources.list())
      .resolves.toEqual({ sources: [source] })
    expect(subject.calls).toEqual([{ operation: "agentPlugins.sources.list", input: undefined }])
  })

  test("adds a source, forwarding exactly the registration fields", async () => {
    const subject = account(() => ({ status: 200, body: { source } }))
    const registration = { owner: "acme", repository: "plugins", ref: "main", authority: "user" as const }

    await expect(accountDirectoryApi(subject.port, async () => ({ harnesses: [] })).sources.add(registration))
      .resolves.toEqual({ source })
    expect(subject.calls).toEqual([{ operation: "agentPlugins.sources.add", input: registration }])
  })

  test("turns a 422 diagnostic response into a thrown DirectorySourceError, not a status result", async () => {
    // The marketplace defect this guards against: an `add` that returned the
    // raw status object instead of throwing would let the add form treat a
    // rejected registration as a saved one.
    const subject = account(() => ({
      status: 422,
      body: {
        error: {
          code: "agent_plugins_source_invalid",
          message: "No valid plugin found in acme/plugins",
          diagnostics: [
            { sourceId: "src_pending", relativePath: "plugin.json", code: "missing_manifest", message: "no manifest" },
          ],
        },
      },
    }))

    const call = accountDirectoryApi(subject.port, async () => ({ harnesses: [] })).sources.add({
      owner: "acme",
      repository: "plugins",
    })

    await expect(call).rejects.toBeInstanceOf(DirectorySourceError)
    try {
      await call
      throw new Error("expected sources.add to reject")
    } catch (error) {
      expect(error).toBeInstanceOf(DirectorySourceError)
      const directoryError = error as DirectorySourceError
      expect(directoryError.code).toBe("agent_plugins_source_invalid")
      expect(directoryError.message).toBe("No valid plugin found in acme/plugins")
      expect(directoryError.diagnostics).toEqual([
        { sourceId: "src_pending", relativePath: "plugin.json", code: "missing_manifest", message: "no manifest" },
      ])
    }
  })

  test("also throws a DirectorySourceError for a 409 conflict", async () => {
    const subject = account(() => ({
      status: 409,
      body: { error: { code: "agent_plugins_source_exists", message: "Source already registered" } },
    }))

    await expect(
      accountDirectoryApi(subject.port, async () => ({ harnesses: [] })).sources.add({
        owner: "acme",
        repository: "plugins",
      }),
    ).rejects.toThrow("Source already registered")
  })

  test("removes a source through the named operation", async () => {
    const subject = account(() => ({ status: 200 }))

    await expect(accountDirectoryApi(subject.port, async () => ({ harnesses: [] })).sources.remove("src_1"))
      .resolves.toBeUndefined()
    expect(subject.calls).toEqual([{ operation: "agentPlugins.sources.remove", input: { id: "src_1" } }])
  })

  test("treats a 404 removal as success rather than an error", async () => {
    const subject = account(() => ({ status: 404, body: { error: { code: "not_found", message: "gone" } } }))

    await expect(accountDirectoryApi(subject.port, async () => ({ harnesses: [] })).sources.remove("src_1"))
      .resolves.toBeUndefined()
  })

  test("delegates machineInstalled to the injected local reader without a hosted operation", async () => {
    const machine = { harnesses: [{ harnessId: "claude" as const, entries: [] }] }
    const subject = account(() => {
      throw new Error("machineInstalled must not call a hosted operation")
    })

    await expect(accountDirectoryApi(subject.port, async () => machine).machineInstalled())
      .resolves.toEqual(machine)
    expect(subject.calls).toEqual([])
  })
})
