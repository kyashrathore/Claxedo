import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { SessionBroker } from "../../contract"
import { harnessVersionStanding } from "../../contract"
import { scriptedPi } from "./test-support/scripted-pi"
import { PI_RANGE } from "./version"

test("a Pi older than the tested range refuses the session by name before its RPC process starts", async () => {
  const pi = await scriptedPi({ version: "0.87.1" })
  try {
    await expect(pi.transport.start(pi.start(), pi.broker)).rejects.toMatchObject({ transport: "pi", code: "configuration", retryable: false,
      message: `Pi 0.87.1 is installed, and Claxedo needs Pi ${PI_RANGE.min} or newer. Update Pi, then send the message again.` })
    expect(pi.versions).toHaveLength(1)
    expect(pi.launches).toEqual([])
  } finally { await pi.close() }
})

test("a draft probe of an older Pi is refused the same way", async () => {
  const pi = await scriptedPi({ version: "0.85.1" })
  try {
    await expect(pi.transport.config.options({ draft: pi.draft() }, "probe")).rejects.toMatchObject({ transport: "pi", code: "configuration" })
    expect(pi.launches).toEqual([])
  } finally { await pi.close() }
})

test("a Pi that prints no version is refused as unreadable", async () => {
  const pi = await scriptedPi({ version: "pi dev build" })
  try {
    await expect(pi.transport.start(pi.start(), pi.broker)).rejects.toMatchObject({ transport: "pi", code: "protocol",
      message: `Pi reported no readable version: "pi dev build"` })
  } finally { await pi.close() }
})

test("a Pi newer than the tested range runs, with one untested-version diagnostic per transport", async () => {
  const pi = await scriptedPi({ version: "0.100.0" })
  const published: unknown[] = []
  const broker = { ...pi.broker, publish: async (event: unknown) => { published.push(event) } } as unknown as SessionBroker
  try {
    const session = await pi.transport.start(pi.start(), broker)
    await pi.transport.close(session)
    await pi.transport.attach({ ...pi.start(), binding: session.binding }, broker)
    expect(published).toEqual([{ type: "diagnostic", diagnostic: { code: "pi.untested_version", severity: "warn", source: "pi.rpc", method: "--version",
      message: `Pi 0.100.0 is newer than ${PI_RANGE.max}, the newest version Claxedo is tested against` } }])
    expect(pi.versions.map((command) => command.args.at(-1))).toEqual(["--version", "--version"])
  } finally { await pi.close() }
})

test("every sandbox image installs a Pi inside the tested range", () => {
  const repo = path.resolve(import.meta.dirname, "../../../../..")
  const pins = ["packages/claxedo-server/scripts/sandbox/Dockerfile", "packages/claxedo-server/scripts/sandbox/cloudflare-worker/Dockerfile",
    "packages/sandbox-manager/src/drivers/vercel.ts"]
    .flatMap((file) => [...readFileSync(path.join(repo, file), "utf8").matchAll(/@earendil-works\/pi-coding-agent@(\d+\.\d+\.\d+)/g)].map((match) => match[1]))
  expect(pins).toHaveLength(4)
  for (const pin of pins) expect(harnessVersionStanding(PI_RANGE, pin)).toBe("tested")
})
