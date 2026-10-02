import { expect, test } from "bun:test"
import path from "node:path"
import { comparisonShape, difference, frameEntity, latestStatusSubject, normalizeWireCorpus } from "./wire-corpus"

test("wire normalization preserves cross-channel identity, state, phase and order", () => {
  const result = normalizeWireCorpus({
    frames: [
      { id: "message.part.updated:ses_11111111:000001_call_aaaaaaaa", phase: "running", observedAt: 1790000000000 },
      { id: "message.part.updated:ses_11111111:000001_call_aaaaaaaa", state: "needs_action" },
    ],
    stored: { sessionID: "ses_11111111", tool: "call_aaaaaaaa", connectionId: "scripted-acp", modelId: "claude-sonnet-4.5", state: "failed", phase: "settled" },
  }) as { frames: Array<{ id: string; phase?: string; state?: string; observedAt?: string }>; stored: { sessionID: string; tool: string; connectionId: string; modelId: string; state: string; phase: string } }
  expect(result.frames[0]?.id).toBe(result.frames[1]?.id)
  expect(result.frames[0]?.id).toContain(result.stored.sessionID)
  expect(result.frames[0]?.id).toContain(result.stored.tool)
  expect(result.frames[0]?.phase).toBe("running")
  expect(result.frames[1]?.state).toBe("needs_action")
  expect(result.stored.state).toBe("failed")
  expect(result.stored.phase).toBe("settled")
  expect(result.stored.connectionId).toBe("scripted-acp")
  expect(result.stored.modelId).toBe("claude-sonnet-4.5")
  expect(result.frames[0]?.observedAt).toBe("<time>")
})

test("wire normalization keeps temporary runtime identities linked", () => {
  const result = normalizeWireCorpus({
    live: { pid: 12345, subagent: "subagent_aaaaaaaa", socket: "/tmp/cc-socks/12345.sock", id: "goal.updated:ses_11111111:1790000000000" },
    stored: { processId: "12345", subagent: "subagent_aaaaaaaa", socket: "/tmp/cc-socks/12345.sock", id: "goal.updated:ses_11111111:1790000000000", error: "Could not read pid 12345: ps -p 12345" },
  }) as { live: { pid: string; subagent: string; socket: string; id: string }; stored: { processId: string; subagent: string; socket: string; id: string; error: string } }
  expect(result.live.pid).toBe(result.stored.processId)
  expect(result.live.subagent).toBe(result.stored.subagent)
  expect(result.live.socket).toBe(result.stored.socket)
  expect(result.live.id).toBe(result.stored.id)
  expect(result.stored.error).toContain(`pid ${result.live.pid}`)
  expect(result.stored.error).toContain(`-p ${result.live.pid}`)
})

test("an OpenCode form ID keeps one placeholder across its question key, event ID and reply route", () => {
  const form = "frm_0ebba14e0001EFuA7J5oM7wMZO"
  const result = normalizeWireCorpus({ key: `question:${form}`, id: `question.replied:ses_11111111:${form}`, route: `/question/${form}/reply` }) as
    { key: string; id: string; route: string }
  const placeholder = result.key.slice("question:".length)
  expect(placeholder).not.toContain("frm_")
  expect(result.id.endsWith(`:${placeholder}`)).toBe(true)
  expect(result.route).toBe(`/question/${placeholder}/reply`)
})

test("a hosted person's user ID is one placeholder wherever the account and its frames name it", () => {
  const user = "usr_a596d3ffb51c4d05d832306e8fa1b710"
  const result = normalizeWireCorpus({ author: { id: user, kind: "human" }, member: { userId: user } }) as
    { author: { id: string }; member: { userId: string } }
  expect(result.author.id).not.toContain("usr_")
  expect(result.member.userId).toBe(result.author.id)
})

test("goal event IDs normalize their embedded second timestamps", () => {
  const first = normalizeWireCorpus({ id: "goal.updated:ses_11111111:1790334985" })
  const second = normalizeWireCorpus({ id: "goal.updated:ses_11111111:1790337074" })
  expect(first).toEqual(second)
})

test("state and phase values remain literal even when numeric", () => {
  expect(normalizeWireCorpus({ state: 1790000000000, phase: 1790000000000, observedAt: 1790000000000 }))
    .toEqual({ state: 1790000000000, phase: 1790000000000, observedAt: "<time>" })
})

test("the Claude Code CLI version and a calendar date are environment facts", () => {
  expect(normalizeWireCorpus({ raw: { claude_code_version: "2.1.283" }, daily: [{ date: "2026-09-26", title: "2026-09-26" }] }))
    .toEqual({ raw: { claude_code_version: "<claude-code-version>" }, daily: [{ date: "<date>", title: "2026-09-26" }] })
})

test("frame comparison keeps order inside an entity and accepts cross-entity interleaving", () => {
  const session = (id: string, phase: string) => ({ data: { payload: { type: "session.lifecycle", sessionID: id, phase } } })
  const frames = [session("ses_11111111", "creating"), session("ses_22222222", "creating"),
    session("ses_11111111", "created"), session("ses_22222222", "created")]
  const shaped = (value: unknown[]) => comparisonShape([{ kind: "stream", route: "/events", frames: value }])
  expect(difference(shaped(frames), shaped([frames[1], frames[0], frames[3], frames[2]]))).toBeUndefined()
  expect(difference(shaped(frames), shaped([frames[2], frames[1], frames[0], frames[3]]))).toContain("phase")
  expect(difference(shaped(frames), shaped([frames[0], frames[1], frames[2]]))).toContain("frames")
  const diagnostic = { data: { payload: { type: "runtime.diagnostic", properties: { sessionID: "ses_11111111", code: "unmapped_event" } } } }
  expect(difference(shaped([frames[0], diagnostic]), shaped([diagnostic, frames[0]]))).toContain("type")
  expect(difference(shaped(frames), shaped([{ data: { type: "heartbeat" } }, ...frames]))).toBeUndefined()
  expect(frameEntity(frames[0])).toBe("session:ses_11111111")
})

test("frame comparison keys messages, parts, requests and children separately", () => {
  const frame = (type: string, properties: Record<string, unknown>) => ({ data: { payload: { type, properties } } })
  expect(frameEntity(frame("message.updated", { info: { id: "msg_1" }, sessionID: "ses_1" }))).toBe("message:msg_1")
  expect(frameEntity(frame("message.part.updated", { part: { id: "prt_1" }, sessionID: "ses_1" }))).toBe("part:prt_1")
  expect(frameEntity(frame("permission.asked", { id: "per_1", sessionID: "ses_1" }))).toBe("permission:per_1")
  expect(frameEntity(frame("question.replied", { requestID: "que_1", sessionID: "ses_1" }))).toBe("question:que_1")
  expect(frameEntity(frame("subagent.updated", { update: { sessionID: "ses_child" }, sessionID: "ses_parent" }))).toBe("child:ses_child")
  expect(frameEntity(frame("runtime.diagnostic", { sessionID: "ses_1", code: "unmapped_event" }))).toBe("session:ses_1")
})

test("vendor status comparison keeps only the final value per subject", () => {
  const status = (value: string, server = "claxedo") => ({ data: { payload: { type: "runtime.diagnostic", properties: {
    sessionID: "ses_11111111", code: "runtime.mcp_server_status", mcp: { serverName: server, status: value },
  } } } })
  const shaped = (frames: unknown[]) => comparisonShape([{ kind: "stream", route: "/events", frames }])
  const baseline = shaped([status("starting"), status("ready"), status("ready", "other")])
  expect(difference(baseline, shaped([status("ready"), status("ready", "other")]))).toBeUndefined()
  expect(difference(baseline, shaped([status("starting"), status("failed"), status("ready", "other")]))).toContain("failed")
  expect(latestStatusSubject(status("ready"))).toBe("runtime.mcp_server_status:claxedo")
})

test("latest-status subjects separate server, native event kind, and rate limit", () => {
  const diagnostic = (code: string, properties: Record<string, unknown>) => ({ data: { payload: {
    type: "runtime.diagnostic", properties: { sessionID: "ses_11111111", code, ...properties },
  } } })
  expect(latestStatusSubject(diagnostic("claude_sdk.unmapped_event", {
    diagnostic: { method: "claude/system", raw: { type: "system", subtype: "init" } },
  }))).toBe("claude_sdk.unmapped_event:claude/system:init")
  expect(latestStatusSubject(diagnostic("codex_app_server.unmapped_event", {
    diagnostic: { method: "thread/settings/updated", raw: {} },
  }))).toBe("codex_app_server.unmapped_event:thread/settings/updated:")
  expect(latestStatusSubject(diagnostic("runtime.rate_limit", {
    rateLimit: { limitId: "codex" },
  }))).toBe("runtime.rate_limit:codex")
  expect(latestStatusSubject(diagnostic("pi.retry", {}))).toBeUndefined()
  expect(latestStatusSubject({ data: { payload: { type: "session.background-work", properties: { sessionID: "ses_11111111", agents: 0 } } } }))
    .toBe("session.background-work")
})

test("an extra ID in one entity does not renumber another entity", () => {
  const frame = (sessionID: string, value: Record<string, unknown>) => ({ data: { payload: { type: "session.updated", properties: { sessionID, ...value } } } })
  const shaped = (first: Record<string, unknown>) => comparisonShape([{ kind: "stream", route: "/events", frames: [
    frame("ses_11111111", first), frame("ses_22222222", { info: { id: "msg_22222222" } }),
  ] }]) as Array<{ entities: Array<{ key: string; frames: unknown[] }> }>
  expect(shaped({ info: { id: "msg_11111111" } })[0]?.entities[1]).toEqual(
    shaped({ unrelatedId: "req_aaaaaaaa", info: { id: "msg_11111111" } })[0]?.entities[1],
  )
})

test("generated workspace IDs match across relay routes, queries, and payloads while route shape stays literal", () => {
  const workspace = "ws_muh7abhv_bq6dxzpr13qrxyp9"
  const other = "ws_muh7as9k_hajsh1bg13qrxyp9"
  const observations = (id: string, route = "/api/wr/events") => comparisonShape([
    { kind: "stream", route: `/workspaces/${id}${route}?workspaceId=${id}`, frames: [] },
    { kind: "http", method: "GET", route: `/api/workspace/resolve?workspaceId=${id}`, status: 200, body: { workspaceId: id } },
  ]) as Array<{ route: string; body?: { workspaceId: string } }>
  const expected = observations(workspace)
  const actual = observations(other)
  expect(difference(expected, actual)).toBeUndefined()
  const placeholder = actual[1]?.body?.workspaceId
  expect(placeholder).toBeDefined()
  expect(actual[0]?.route).toContain(`/workspaces/${placeholder}/`)
  expect(actual[0]?.route).toContain(`workspaceId=${placeholder}`)
  expect(difference(expected, observations(other, "/api/wr/renamed-events"))).toContain("route")
})

test("a hosted stack's temporary root normalizes like the local stack's data directory", () => {
  const result = normalizeWireCorpus({
    hosted: "/var/folders/t2/abc/T/claxedo-hosted-h31-accounts-lyy3Lv/sandbox-workspaces/project",
    product: "/private/var/folders/t2/abc/T/h19-product-host-niTU0H/workspaces/w1",
  }) as { hosted: string; product: string }
  expect(result.hosted).toBe("<data-dir>/sandbox-workspaces/project")
  expect(result.product).toBe("<workspace:value:1>")
})

test("run-local values normalize: an actor id, a digest and timestamps inside raw harness lines", () => {
  const result = normalizeWireCorpus({
    actorId: "act_4c24c830a021c693c5c6bcace9d15828",
    delta: "56d2fe28c7026db5dfa4144d76f482bb855f00ecf31b40f5a4306407f6225107",
    raw: "{\"isError\":false,\"timestamp\":1790640318314}",
    excerpt: "{\"subtype\":\"informational\",\"timestamp\":\"2026-09-30T09:25:53.257Z\"}",
    title: "5822feb31efae0d63b8ab72cb3e383bf64187deb7815820b794a1f7ab47…",
  }) as Record<string, string>
  expect(result.actorId).toBe("<id:value:1>")
  expect(result.delta).toBe("<sha256>")
  expect(result.raw).toBe("{\"isError\":false,\"timestamp\":<time>}")
  expect(result.excerpt).toBe("{\"subtype\":\"informational\",\"timestamp\":\"<time>\"}")
  expect(result.title).toBe("<sha256>…")
})

test("a Codex session home named in a Codex warning is run-local", () => {
  const warning = (home: string) => normalizeWireCorpus({ message: `To suppress this warning, set it in /tmp/claxedo-e2e-h5-abc/.claxedo/harness/codex/homes/codex-owner-1d71abcc5dcbef36/homes/codex-${home}/config.toml.` })
  expect(warning("e614cd53e077b5e8")).toEqual(warning("86cd0cb8fdc841a9"))
})

test("a Claude background agent's id and its task file under Claude's temp root are run-local", () => {
  const launched = (agent: string) => normalizeWireCorpus({ output: `agentId: ${agent} (Use SendMessage with to: '${agent}')\noutput_file: /private/tmp/claude-501/-private-var-folders-t2-x/ses_11111111/tasks/${agent}.output` })
  expect(launched("a8a58028709803b6d")).toEqual(launched("a010a4860fd4930ec"))
})

test("the checkout root and the runtime executable are environment facts", () => {
  const agent = path.resolve(import.meta.dirname, "../../../..", "packages/harness/e2e/harness/acp/agent.ts")
  const result = normalizeWireCorpus({ command: process.execPath, args: [agent] }) as { command: string; args: string[] }
  expect(result).toEqual({ command: "<bun>", args: ["<repo>/packages/harness/e2e/harness/acp/agent.ts"] })
})
