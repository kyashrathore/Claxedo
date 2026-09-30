import fs from "node:fs/promises"
import path from "node:path"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import type { Deadline, HarnessVersionRange, OwnedProcess } from "../../contract"
import { TransportError } from "../../contract/errors"

export const PI_RANGE = { transport: "pi", program: "Pi", min: "0.99.0", max: "0.99.1" } as const satisfies HarnessVersionRange

async function printed(owned: OwnedProcess): Promise<string> {
  owned.stderr.resume()
  const chunks: Buffer[] = []
  for await (const chunk of owned.stdout) chunks.push(Buffer.from(chunk))
  const exit = await owned.exited
  if (exit.code !== 0) throw new TransportError("pi", "process", `pi --version exited (${String(exit.signal ?? exit.code)})`)
  return Buffer.concat(chunks).toString("utf8").trim()
}

export async function piReportedVersion(owned: OwnedProcess, deadline: Deadline): Promise<string> {
  try {
    return await settleAtRequestDeadline("pi --version", { deadlineAt: deadline.at, signal: deadline.signal }, printed(owned), () => {},
      (what, aborted) => new TransportError("pi", "timeout", `${what} ${aborted ? "was abandoned" : "timed out"}`))
  } finally {
    const retired = await owned.retire(deadline)
    if (!retired.stopped) throw new TransportError("pi", "retirement", retired.error.message)
  }
}

async function binaryIdentity(binary: string): Promise<string | undefined> {
  if (!path.isAbsolute(binary)) return undefined
  const real = await fs.realpath(binary)
  const stat = await fs.stat(real)
  return JSON.stringify([real, stat.ino, stat.size, stat.mtimeMs])
}

export class PiVersionReadings {
  private readonly readings = new Map<string, Promise<string>>()

  async read(binary: string, spawnReading: () => Promise<string>): Promise<string> {
    const identity = await binaryIdentity(binary)
    if (!identity) return spawnReading()
    const known = this.readings.get(identity)
    if (known) return known
    const reading = spawnReading().then((version) => version, (error: unknown) => {
      this.readings.delete(identity)
      throw error
    })
    this.readings.set(identity, reading)
    return reading
  }
}
