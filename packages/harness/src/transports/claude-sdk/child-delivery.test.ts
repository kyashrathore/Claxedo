import { expect, test } from "bun:test"
import { collect, frame, init, background, reply, result, setup, turnBroker, until, userTurn } from "./test-support/live"

const handback = () => frame({ type: "user", isReplay: true, parent_tool_use_id: null,
  origin: { kind: "peer", from: "reviewer", senderTaskId: "child-task", body: "The child report" },
  message: { role: "user", content: "Peer envelope" } })

test("an idle report publishes as an event, then init opens a continuation without another SDK prompt", async () => {
  const { transport, session, launches, own, published, publishedTargets } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start the child"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("child-task"))
  claude.frames.push(result())
  await first
  claude.frames.push(handback())
  claude.frames.push(init())
  claude.frames.push(reply("Received the report"))
  claude.frames.push(result())
  await until(() => own.length === 1)
  await own[0]!.done
  expect(publishedTargets[published.findIndex((event) => (event as { type: string }).type === "agent-message")]).toBe("a-t1")
  expect(published.filter((event) => (event as { type: string }).type === "agent-message"))
    .toMatchObject([{ type: "agent-message", sender: "reviewer", message: "The child report" }])
  expect(claude.prompts).toEqual(["start the child"])
  expect(own[0]!.events.some(({ event }) => event.type === "agent-message")).toBe(false)
  claude.frames.push(background())
  claude.frames.end()
  await transport.dispose()
})

test("a replayed peer report in a claimed turn is translated, not mistaken for a prompt echo", async () => {
  const { transport, session, launches } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "start the child"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(handback())
  claude.frames.push(result())
  expect((await turn).filter(({ event }) => event.type === "agent-message"))
    .toMatchObject([{ event: { type: "agent-message", sender: "reviewer", message: "The child report" } }])
  claude.frames.end()
  await transport.dispose()
})

test("multiple idle child reports and completion notices are delivered in ingress order without opening prompts", async () => {
  const { transport, session, launches, own, published, publishedTargets } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start the children"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("child-1", "child-2"))
  claude.frames.push(result())
  await first
  for (const [sender, eventId] of [["reviewer-1", "peer-1"], ["reviewer-2", "peer-2"]]) {
    if (sender === "reviewer-1") claude.frames.push(frame({ type: "system", subtype: "task_notification", task_id: "child-1", status: "completed", summary: "First child finished" }))
    claude.frames.push(frame({ type: "user", uuid: eventId, isReplay: true, parent_tool_use_id: null,
      origin: { kind: "peer", from: sender, body: `${sender} report` }, message: { role: "user", content: "Peer envelope" } }))
    if (sender === "reviewer-2") claude.frames.push(frame({ type: "system", subtype: "task_notification", task_id: "child-2", status: "completed", summary: "Second child finished" }))
  }
  await until(() => published.filter((event) => ["agent-message", "harness-notice"].includes((event as { type: string }).type)).length === 4)
  const notices = published.flatMap((event, index) => ["agent-message", "harness-notice"].includes((event as { type: string }).type) ? [{ event, owner: publishedTargets[index] }] : [])
  expect(notices.map(({ event }) => (event as { type: string }).type)).toEqual(["harness-notice", "agent-message", "agent-message", "harness-notice"])
  expect(notices.every(({ owner }) => owner === "a-t1")).toBe(true)
  expect(own).toHaveLength(0)
  expect(claude.prompts).toEqual(["start the children"])
  claude.frames.push(background())
  claude.frames.end()
  await transport.dispose()
})
