import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import type { TurnBroker, TurnInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { scriptedPi } from "./test-support/scripted-pi"

const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", todos: [],
  origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
  prompt: { agent: "build", assistantMessageId: "a1", parts: [{ type: "text", text: "hello" }] } }

const turnBroker = { signal: new AbortController().signal } as unknown as TurnBroker

const resumeArgs = (args: readonly string[]) => args.flatMap((arg, index) =>
  arg === "--session" || arg === "--session-id" ? [arg, args[index + 1]] : [])

test("a Pi session that never had a turn attaches after a restart as a fresh Pi session under its id", async () => {
  const pi = await scriptedPi()
  try {
    const session = await pi.transport.start(pi.start(), pi.broker)
    await pi.transport.close(session)
    const attached = await pi.transport.attach({ ...pi.start(), binding: session.binding, upstreamHasTurns: false }, pi.broker)
    expect(attached.binding.upstreamSessionId).toBe("scripted-pi")
    expect(resumeArgs(pi.launches[1]!.command.args)).toEqual(["--session-id", "scripted-pi"])
  } finally { await pi.close() }
})

test("a Pi session that had a turn resumes its session file, and refuses to attach once that file is gone", async () => {
  const pi = await scriptedPi()
  try {
    const session = await pi.transport.start(pi.start(), pi.broker)
    for await (const _event of pi.transport.send(session, turn, turnBroker)) {}
    await pi.transport.close(session)
    const attach = () => pi.transport.attach({ ...pi.start(), binding: session.binding, upstreamHasTurns: true }, pi.broker)
    await pi.transport.close(await attach())
    const [flag, file] = resumeArgs(pi.launches[1]!.command.args)
    expect(flag).toBe("--session")
    await fs.rm(file!)
    const refused = await attach().catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(TransportError)
    expect(refused).toMatchObject({ code: "session", retryable: false, detail: { upstreamSessionId: "scripted-pi" } })
    expect(pi.launches).toHaveLength(2)
  } finally { await pi.close() }
})
