import { Buffer } from "node:buffer"
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { basename } from "node:path"
import { COMMIT, FAILED, FATAL, PAYLOAD_HEADER_BYTES, PUBLISHED, READY, REQUEST_HEADER_BYTES, SERVING } from "./windows-private-file-program"

/**
 * A stand-in for the PowerShell runner that speaks its protocol over the same
 * pipes with plain files, so the request queue, the answer handling and runner
 * replacement run on every platform. It protects nothing.
 *
 * The target's file name picks a misbehaviour:
 * - `refuse-*`: answers FAILED instead of READY and keeps serving.
 * - `die-before-ready-*`: exits 3 on receiving the request.
 * - `die-mid-answer-*`: publishes, writes half of PUBLISHED, and exits.
 * - `wedge-*`: never answers.
 * - `fatal-*`: answers FATAL and exits.
 */

let buffered = Buffer.alloc(0)
let ended = false
let wake: (() => void) | undefined

process.stdin.on("data", (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk])
  wake?.()
})
process.stdin.on("end", () => {
  ended = true
  wake?.()
})

async function nextBytes(count: number): Promise<Buffer | undefined> {
  while (buffered.length < count) {
    if (ended) return undefined
    await new Promise<void>((settle) => { wake = settle })
    wake = undefined
  }
  const taken = buffered.subarray(0, count)
  buffered = buffered.subarray(count)
  return taken
}

function writeAnswerLine(line: string) {
  process.stdout.write(`${line}\r\n`)
}

writeAnswerLine(SERVING)
for (;;) {
  const header = await nextBytes(REQUEST_HEADER_BYTES)
  if (!header) process.exit(0)
  const names = await nextBytes(header.readUInt32LE(5) + header.readUInt32LE(9))
  if (!names) process.exit(1)
  const staging = names.subarray(0, header.readUInt32LE(5)).toString("utf16le")
  const target = names.subarray(header.readUInt32LE(5)).toString("utf16le")
  const name = basename(target)

  if (name.startsWith("refuse-")) {
    writeAnswerLine(`${FAILED}the staging file could not be created`)
    continue
  }
  if (name.startsWith("die-before-ready-")) process.exit(3)
  if (name.startsWith("wedge-")) await new Promise(() => undefined)
  if (name.startsWith("fatal-")) {
    writeAnswerLine(`${FATAL}the caller sent an unrecognised request`)
    process.exit(1)
  }

  const descriptor = openSync(staging, "wx")
  writeAnswerLine(`${READY}O:S-1-5-21-0D:PAI(A;;FA;;;S-1-5-21-0)`)
  const frame = await nextBytes(PAYLOAD_HEADER_BYTES)
  if (!frame) process.exit(1)
  if (frame.readUInt8(5) !== COMMIT) {
    closeSync(descriptor)
    unlinkSync(staging)
    writeAnswerLine(`${FAILED}the caller cancelled the write`)
    continue
  }
  const contents = await nextBytes(Number(frame.readBigUInt64LE(6)))
  if (!contents) process.exit(1)
  writeSync(descriptor, contents)
  closeSync(descriptor)
  renameSync(staging, target)
  if (name.startsWith("die-mid-answer-")) {
    process.stdout.write(PUBLISHED.slice(0, 4), () => process.exit(4))
    await new Promise(() => undefined)
  }
  writeAnswerLine(PUBLISHED)
}
