import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { SessionBroker } from "../../contract"
import { harnessVersionStanding } from "../../contract"
import { scriptedTransport } from "./test-support/transport"
import { CODEX_RANGE, codexReportedVersion } from "./version"

test("the version is read from the userAgent each Codex answers initialize with", () => {
  expect(codexReportedVersion({ userAgent: "claxedo/0.159.0 (Mac OS 26.6.2; arm64) unknown (claxedo; 0.1.0)" })).toBe("0.159.0")
  expect(codexReportedVersion({ userAgent: "claxedo/0.153.4 (Mac OS 26.6.2; arm64) unknown (claxedo; 0.1.0)" })).toBe("0.153.4")
  expect(codexReportedVersion({ userAgent: "codex-conformance" })).toBe("codex-conformance")
  expect(codexReportedVersion({})).toBeUndefined()
})

test("a Codex older than the tested range refuses the session by name, and nothing is left running", async () => {
  const peer = await scriptedTransport({ userAgent: "claxedo/0.153.4 (Mac OS 26.6.2; arm64) unknown (claxedo; 0.1.0)" })
  try {
    await expect(peer.transport.start(peer.startInput, peer.liveBroker())).rejects.toMatchObject({ transport: "codex", code: "configuration", retryable: false,
      message: "Codex 0.153.4 is installed, and Claxedo needs Codex 0.156.1 or newer. Update Codex, then send the message again." })
    expect(peer.retired()).toBe(1)
    expect(peer.frames.some((frame) => frame.method === "thread/start")).toBe(false)
  } finally { await peer.close() }
})

test("a Codex newer than the tested range runs, with one untested-version diagnostic per transport", async () => {
  const peer = await scriptedTransport({ userAgent: "claxedo/0.160.0 (Mac OS 26.6.2; arm64) unknown (claxedo; 0.1.0)" })
  const published: unknown[] = []
  const broker = () => ({ ...peer.liveBroker(), publish: async (event: unknown) => { published.push(event) } } as unknown as SessionBroker)
  try {
    const session = await peer.transport.start(peer.startInput, broker())
    await peer.transport.close(session)
    await peer.transport.attach({ ...peer.startInput, binding: session.binding, upstreamHasTurns: false }, broker())
    expect(published).toEqual([{ type: "diagnostic", diagnostic: { code: "codex.untested_version", severity: "warn", source: "codex.app-server", method: "initialize",
      message: "Codex 0.160.0 is newer than 0.159.2, the newest version Claxedo is tested against" } }])
  } finally { await peer.close() }
})

test("the Codex the protocol types are generated from and every sandbox image runs are inside the tested range", () => {
  const repo = path.resolve(import.meta.dirname, "../../../../..")
  const read = (file: string) => readFileSync(path.join(repo, file), "utf8")
  const generator = JSON.parse(read("packages/harness/package.json")).devDependencies["@openai/codex"]
  const sandboxes = ["packages/claxedo-server/scripts/sandbox/Dockerfile", "packages/sandbox-manager/src/drivers/vercel.ts"]
    .flatMap((file) => [...read(file).matchAll(/@openai\/codex@(\d+\.\d+\.\d+)/g)].map((match) => match[1]))
  expect(generator).toBe(CODEX_RANGE.min)
  expect(sandboxes).toHaveLength(2)
  for (const version of [generator, ...sandboxes]) expect(harnessVersionStanding(CODEX_RANGE, version)).toBe("tested")
})
