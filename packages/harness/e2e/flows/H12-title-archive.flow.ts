import assert from "node:assert/strict"
import { ClaxedoApi, assistantText, type SessionHarness } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { eventually } from "../harness/eventually"
import { connectScriptedProviders } from "../harness/scripted-providers"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport } from "../harness/transport"
import { waitForIdle, waitForTitle } from "../harness/turn-observations"

export async function titleAndArchive(stack: Stack, api: ClaxedoApi, name: "acp" | "pi" | "claude" | "codex") {
  const directory = (await stack.daemon.makeWorkspace(`h12-${name}`)).directory
  const stream = await stack.events(directory)
  const harness: SessionHarness = name === "acp" ? SCRIPTED_ACP_HARNESS : { id: name, access: "native" }
  const model = name === "pi" ? { providerId: "pi", modelId: "openai/gpt-4.1" } : undefined
  const session = await api.createSession(directory, { harness, ...(model ? { model } : {}) })
  const first = `H12_${name.toUpperCase()}_FIRST`
  await api.prompt(directory, session.id, `Reply with exactly this one token: ${first}`, { ...(model ? { model } : {}), title: name !== "claude" })
  await waitForIdle(stream, session.id)
  const firstMessages = await api.messages(directory, session.id)
  assert.match(assistantText(firstMessages), new RegExp(first))
  const firstAssistantId = firstMessages.filter((message) => message.info.role === "assistant").at(-1)?.info.id
  if (name !== "claude") await waitForTitle(stream, session.id)
  const titled = await api.session(directory, session.id)
  assert.ok(titled.title, `${name} first turn produced no title`)
  assert.ok(stream.frames.some((frame) => frameType(frame) === "session.updated" && frameSessionId(frame) === session.id), `${name} title was not streamed`)

  const renamed = `H12 renamed ${name}`
  assert.equal((await api.updateSession(directory, session.id, { title: renamed })).title, renamed)
  assert.equal((await api.session(directory, session.id)).title, renamed)

  const marker = `H12_${name.toUpperCase()}_RUNNING`
  let release: () => Promise<void> | void
  if (name === "acp") {
    await stack.acp.write(`h12-hold-${name}`, { steps: [
      { kind: "text", text: "H12 held turn began" },
      { kind: "hold", name: `h12-hold-${name}` },
      { kind: "text", text: "SHOULD_NOT_FINISH" },
    ] })
    release = () => stack.acp.release(`h12-hold-${name}`)
  } else {
    release = stack.scripted.holdTextReplies(marker)
  }
  try {
    const prompt = name === "acp" ? `${marker} ${acpScriptToken(`h12-hold-${name}`)}` : `Reply with exactly this one token: ${marker}`
    await api.promptAsync(directory, session.id, prompt)
    await stream.waitFor((frame) => frameType(frame) === "session.status" && frameSessionId(frame) === session.id
      && (frame.data.payload as { properties?: { status?: { type?: string } } })?.properties?.status?.type === "busy", {
      label: `${name} running turn`, timeoutMs: 20_000,
    })
    if (name === "acp") {
      await stream.waitFor((frame) => frameSessionId(frame) === session.id && !!frameType(frame)?.startsWith("message.part")
        && JSON.stringify(frame.data.payload).includes("H12 held turn began"), { label: "ACP held turn text" })
    } else {
      await eventually(`${name} held model request`, async () => stack.scripted.requests.some((request) => request.prompt.includes(marker)) || undefined)
    }
    const archivedAt = Date.now()
    const beforeArchive = stream.frames.length
    const archived = await api.updateSession(directory, session.id, { time: { archived: archivedAt } })
    assert.equal(archived.time.archived, archivedAt)
    assert.equal((await api.session(directory, session.id)).time.archived, archivedAt)
    assert.ok((await api.archivedSessions(directory)).some((row) => row.id === session.id && row.time.archived === archivedAt))
    assert.ok(!(await api.visibleSessions(directory)).some((row) => row.id === session.id), `${name} archived session remained active`)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id && stream.frames.indexOf(frame) >= beforeArchive,
      { label: `${name} archived turn outcome` })
    const last = (await api.messages(directory, session.id)).filter((message) => message.info.role === "assistant").at(-1)
    assert.ok(last && last.info.id !== firstAssistantId, `${name} archived turn stored no assistant message`)
    assert.ok((last.info.time as { completed?: number }).completed)
    assert.ok(!JSON.stringify(last.parts).includes(marker), `${name} held reply completed after archive`)
    assert.equal((await api.session(directory, session.id)).title, renamed)
    console.log(`H12 ${name}: first title, durable rename, running-turn archive, stored outcome and archived list passed`)
  } finally {
    await release()
  }
}

export async function run() {
  const stack = await startStack({ label: "h12-title-archive" })
  try {
    await connectScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    const failures: Error[] = []
    for (const name of ["pi", "claude", "codex"] as const) {
      try {
        await titleAndArchive(stack, api, name)
      } catch (error) {
        failures.push(new Error(`H12 ${name}: ${String(error)}`, { cause: error }))
      }
    }
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
    if (failures.length) throw new AggregateError(failures, "H12 title/archive variants failed")
  } finally {
    await stack.close()
  }
}
