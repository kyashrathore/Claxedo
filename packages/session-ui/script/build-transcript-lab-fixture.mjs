import { readFileSync, writeFileSync, statSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { reconstructQuestionAnswers } from "../src/components/question-result.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * Data, not source. Transcripts quote real code, so under a `.ts` extension the repo's
 * source guards (`markdown-svg-sanitize.test.ts`, `lint:theme-tokens`) match `.innerHTML =`
 * and hex colours inside the string literals and fail. `transcript-lab-fixture.ts` is a
 * hand-written wrapper that types this file.
 */
const OUTPUT = resolve(HERE, "../src/components/transcript-lab-fixture.json")
const LOG_DIR = "/Users/yashvardhansingh/.claude/projects/-Users-yashvardhansingh-test-opencode"
const OUTPUT_LIMIT = 8000
const TRUNCATION_SUFFIX = "\n… [truncated for fixture]"

const SOURCES = [
  {
    id: "diagnosis",
    title: "Transcript readability diagnosis",
    file: `${LOG_DIR}/e8fbc92a-aef1-4e76-b08c-55ec4212eac5.jsonl`,
    /**
     * The session that works on this lab writes to this log, so without a stop marker
     * every regeneration rewrites the fixture with whatever happened since. This uuid is
     * the last settled turn as of 2026-09-09T16:23Z — a `tool_result` row, so no tool
     * call is left pending at the cut. Move it forward deliberately to take in more.
     */
    untilUuid: "c3e25add-1914-4543-8cda-f2ec92d3c08c",
  },
  { id: "toolrun", file: `${LOG_DIR}/57c90445-b05e-445f-bd67-c3cbe349f7aa.jsonl` },
]

/*
 * The projection canonicalises a harness tool name by lowercasing it and does nothing
 * else, so this fixture must too. Renaming here (LS -> list, Agent -> task) would make
 * the lab group and render transcripts the product cannot.
 */
const TOOL_NAMES = {}

/** Claude Code names tool inputs in snake_case; every renderer in message-part.tsx reads the camelCase key. */
const INPUT_KEYS = {
  read: { file_path: "filePath" },
  edit: { file_path: "filePath", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
  write: { file_path: "filePath" },
  grep: { glob: "include" },
  skill: { skill: "name" },
}

function toolName(name) {
  return TOOL_NAMES[name] ?? String(name).toLowerCase()
}

function toolInput(tool, input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {}
  const renames = INPUT_KEYS[tool]
  if (!renames) return { ...source }
  const result = {}
  for (const [key, value] of Object.entries(source)) result[renames[key] ?? key] = value
  return result
}

function clip(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function shortPath(value, cwd) {
  if (typeof value !== "string" || !value) return ""
  return value.startsWith(cwd) ? relative(cwd, value) || basename(value) : value
}

function toolTitle(tool, input, cwd) {
  switch (tool) {
    case "read":
    case "edit":
    case "write":
      return clip(shortPath(input.filePath, cwd), 100) || tool
    case "list":
      return clip(shortPath(input.path, cwd), 100) || tool
    case "bash":
      return clip(input.description || input.command, 100) || tool
    case "grep":
    case "glob":
      return clip(input.pattern, 100) || tool
    case "webfetch":
      return clip(input.url, 100) || tool
    case "websearch":
      return clip(input.query, 100) || tool
    case "task":
      return clip(input.description, 100) || tool
    case "skill":
      return clip(input.name, 100) || tool
    default:
      return clip(input.description || input.query || input.summary, 100) || tool
  }
}

function truncate(text, limit = OUTPUT_LIMIT) {
  return text.length > limit ? text.slice(0, limit) + TRUNCATION_SUFFIX : text
}

/** Flattens a tool result to text, collecting the image blocks it cannot render into `images`. */
function flattenResult(content, images) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content)
  const pieces = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    if (block.type === "image") {
      images.push(block)
      continue
    }
    pieces.push(typeof block.text === "string" ? block.text : JSON.stringify(block))
  }
  return pieces.join("\n")
}

function imageDataUrl(block) {
  const source = block?.source
  if (source?.type !== "base64" || !source.media_type || !source.data) {
    throw new Error(`image block is not inline base64: ${JSON.stringify(source ?? block).slice(0, 120)}`)
  }
  return { mime: source.media_type, url: `data:${source.media_type};base64,${source.data}` }
}

/**
 * `AgentQuestionAnswer[]` for the `question` renderer. The harness records the pairs in
 * `toolUseResult.answers` and renders the same pairs as prose in the result text; all 54
 * answered calls across the logs carry the record, so the prose is never parsed.
 */
function questionMetadata(input, toolUseResult) {
  const answers = toolUseResult?.answers
  if (!answers || typeof answers !== "object") return {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  return {
    answers: reconstructQuestionAnswers(
      questions.map((question) => ({
        question: String(question?.question ?? ""),
        optionLabels: (Array.isArray(question?.options) ? question.options : []).map((option) =>
          String(option?.label ?? ""),
        ),
        multiple: question?.multiSelect === true,
      })),
      answers,
    ),
  }
}

function timeOf(row) {
  const value = Date.parse(row?.timestamp ?? "")
  return Number.isFinite(value) ? value : 0
}

function usageOf(message) {
  const usage = message?.usage
  if (!usage) return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
    cache: { read: usage.cache_read_input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0 },
  }
}

function deriveTitle(text) {
  const line =
    String(text ?? "")
      .split("\n")
      .find((item) => item.trim()) ?? "Session"
  const trimmed = clip(line.replace(/[.!?].*$/, ""), 60) || "Session"
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}

function padID(prefix, index) {
  return `${prefix}${String(index).padStart(4, "0")}`
}

function readRows(file, counters, untilUuid) {
  const rows = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    counters.rowsRead += 1
    let row
    try {
      row = JSON.parse(line)
    } catch {
      counters.skipped.unparsable += 1
      continue
    }
    rows.push(row)
    if (untilUuid && row.uuid === untilUuid) return rows
  }
  if (untilUuid) throw new Error(`pinned row ${untilUuid} is not in ${file}`)
  return rows
}

function convert(source) {
  const counters = {
    rowsRead: 0,
    skipped: { unparsable: 0, sidechain: 0, meta: 0, notAMessage: 0, emptyUserText: 0, unknownBlock: 0 },
    imagesDropped: 0,
    toolResults: { matched: 0, unmatched: 0 },
  }
  const rows = readRows(source.file, counters, source.untilUuid)

  const sessionID = rows.find((row) => row.sessionId)?.sessionId ?? basename(source.file, ".jsonl")
  const cwd = rows.find((row) => row.cwd)?.cwd ?? "/"

  const messages = []
  const parts = {}
  const toolPartByCallID = new Map()
  const assistantByMessageID = new Map()
  let userMessageID
  let messageCount = 0
  let partCount = 0
  let firstUserText = ""
  const stats = {
    userTurns: 0,
    assistantMessages: 0,
    textParts: 0,
    reasoningParts: 0,
    reasoningWithText: 0,
    toolParts: 0,
    proseChars: 0,
    machineryChars: 0,
  }

  const nextPartID = () => padID("p", (partCount += 1))
  const addPart = (messageID, part) => {
    ;(parts[messageID] ??= []).push(part)
  }

  for (const row of rows) {
    if (row.isSidechain) {
      counters.skipped.sidechain += 1
      continue
    }
    if (row.isMeta) {
      counters.skipped.meta += 1
      continue
    }
    const message = row.message
    const role = message?.role
    if (role !== "user" && role !== "assistant") {
      counters.skipped.notAMessage += 1
      continue
    }
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
    if (!Array.isArray(blocks)) {
      counters.skipped.notAMessage += 1
      continue
    }

    if (role === "user") {
      const results = blocks.filter((block) => block?.type === "tool_result")
      if (results.length && !blocks.some((block) => block?.type === "text")) {
        for (const result of results) {
          const part = toolPartByCallID.get(result.tool_use_id)
          if (!part) {
            counters.toolResults.unmatched += 1
            continue
          }
          counters.toolResults.matched += 1
          const images = []
          const text = truncate(flattenResult(result.content, images))
          counters.imagesDropped += images.length
          stats.machineryChars += text.length
          const start = part.state.time?.start ?? timeOf(row)
          part.state = result.is_error
            ? { status: "error", input: part.state.input, error: text, metadata: {}, time: { start, end: timeOf(row) } }
            : {
                status: "completed",
                input: part.state.input,
                output: text,
                title: part.state.title,
                metadata: part.tool === "question" ? questionMetadata(part.state.input, row.toolUseResult) : {},
                time: { start, end: timeOf(row) },
              }
        }
        continue
      }

      const text = blocks
        .filter((block) => {
          if (block?.type === "image") counters.imagesDropped += 1
          return block?.type === "text"
        })
        .map((block) => block.text ?? "")
        .join("\n")
      if (!text.trim()) {
        counters.skipped.emptyUserText += 1
        continue
      }
      userMessageID = padID("m", (messageCount += 1))
      firstUserText ||= text
      messages.push({
        id: userMessageID,
        sessionID,
        role: "user",
        time: { created: timeOf(row) },
        agent: "claude",
        model: { providerID: "anthropic", modelID: message.model ?? "claude-opus-5" },
      })
      addPart(userMessageID, {
        id: nextPartID(),
        sessionID,
        messageID: userMessageID,
        type: "text",
        text,
        time: { start: timeOf(row) },
      })
      stats.userTurns += 1
      stats.textParts += 1
      stats.proseChars += text.length
      continue
    }

    if (!userMessageID) {
      counters.skipped.notAMessage += 1
      continue
    }

    let assistant = assistantByMessageID.get(message.id)
    if (!assistant) {
      assistant = {
        id: padID("m", (messageCount += 1)),
        sessionID,
        role: "assistant",
        time: { created: timeOf(row), completed: timeOf(row) },
        parentID: userMessageID,
        modelID: message.model ?? "claude-opus-5",
        providerID: "anthropic",
        mode: row.permissionMode ?? "default",
        agent: "claude",
        path: { cwd, root: cwd },
        cost: 0,
        tokens: usageOf(message),
      }
      assistantByMessageID.set(message.id, assistant)
      messages.push(assistant)
      stats.assistantMessages += 1
    }
    assistant.time.completed = Math.max(assistant.time.completed ?? 0, timeOf(row))

    for (const block of blocks) {
      if (block?.type === "text") {
        const text = block.text ?? ""
        addPart(assistant.id, {
          id: nextPartID(),
          sessionID,
          messageID: assistant.id,
          type: "text",
          text,
          time: { start: timeOf(row) },
        })
        stats.textParts += 1
        stats.proseChars += text.length
        continue
      }
      if (block?.type === "thinking") {
        const text = block.thinking ?? ""
        addPart(assistant.id, {
          id: nextPartID(),
          sessionID,
          messageID: assistant.id,
          type: "reasoning",
          text,
          time: { start: timeOf(row) },
        })
        stats.reasoningParts += 1
        if (text.trim()) stats.reasoningWithText += 1
        stats.machineryChars += text.length
        continue
      }
      if (block?.type === "tool_use") {
        const tool = toolName(block.name)
        const input = toolInput(tool, block.input)
        const part = {
          id: nextPartID(),
          sessionID,
          messageID: assistant.id,
          type: "tool",
          callID: block.id,
          tool,
          state: {
            status: "pending",
            input,
            raw: "",
            title: toolTitle(tool, input, cwd),
            time: { start: timeOf(row) },
          },
        }
        toolPartByCallID.set(block.id, part)
        addPart(assistant.id, part)
        stats.toolParts += 1
        stats.machineryChars += JSON.stringify(input).length
        continue
      }
      if (block?.type === "image") {
        counters.imagesDropped += 1
        continue
      }
      counters.skipped.unknownBlock += 1
    }
  }

  for (const part of toolPartByCallID.values()) {
    if (part.state.status !== "pending") continue
    part.state = { status: "pending", input: part.state.input, raw: "" }
  }

  messages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    session: {
      id: source.id,
      title: source.title ?? deriveTitle(firstUserText),
      sessionID,
      messages,
      parts,
      stats,
    },
    counters,
  }
}

const LOG_ROOT = "/Users/yashvardhansingh/.claude/projects"
const OC = `${LOG_ROOT}/-Users-yashvardhansingh-test-opencode`
const CATALOG_SESSION_ID = "transcript-lab-catalog"
const CATALOG_CWD = "/Users/yashvardhansingh/test/opencode"
const CATALOG_OUTPUT_LIMIT = 2500
const CATALOG_START = Date.parse("2026-09-08T09:00:00.000Z")
const CATALOG_GAP_MS = 1500
const CATALOG_DEFAULT_DURATION_MS = 400

/**
 * One turn per tool family, each assembled from a named real call in a named log, so a
 * designer can see every renderable surface on one screen. An entry is either `mine`
 * (a real call, converted by the same helpers the log sessions use), `mine` + `as`
 * (a real result re-labelled as a tool Claude Code never emitted), or `part` (built by
 * hand). Anything not wholly real carries `why`, which lands in the session's
 * `synthetic` list.
 */
const CATALOG_TURNS = [
  {
    label:
      "File tools. `read`, `grep`, `glob` and `list` are the context set — the app folds a consecutive run of them into one collapsed row.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${OC}/0f6285e8-58cf-48fa-a7b7-37d29169c1b6/subagents/agent-ac82767d08572b818.jsonl`,
          tool: "Read",
          match: { file_path: "packages/wakes/src/tools.ts", offset: 30 },
        },
      },
      {
        mine: {
          file: `${OC}/0a6a45ca-7899-448d-bc1e-3be4a20936b8/subagents/agent-a0e35965ce5a13930.jsonl`,
          tool: "Read",
          match: { file_path: "platform/settings/terminal-preferences.ts" },
        },
      },
      {
        mine: {
          file: `${OC}/0f6285e8-58cf-48fa-a7b7-37d29169c1b6/subagents/agent-af92ad57a1dbd5a54.jsonl`,
          tool: "Bash",
          match: { description: "Find expiresAt usage" },
        },
        as: "Grep",
        input: { pattern: "expiresAt", path: `${CATALOG_CWD}/packages/wakes/src`, include: "*.ts" },
        why: "grep: no log has a completed `Grep` call — this shell has `rg`/`grep` on Bash instead, and the only two real `Grep` calls both failed with \"No such tool available\". Output is the verbatim result of a real `grep -n expiresAt packages/wakes/src/wakes.ts`; the tool name and input are written",
      },
      {
        mine: {
          file: `${OC}/14975e8d-a163-43f7-9255-404ad23cfe98/subagents/agent-alane-ui-b1040a6b7dc691bc.jsonl`,
          tool: "Bash",
          match: { description: "Find lib.dom.d.ts in bun store" },
        },
        as: "Glob",
        input: { pattern: "node_modules/.bun/**/lib.dom.d.ts", path: CATALOG_CWD },
        why: "glob: no `Glob` call exists in any log. Output is the verbatim result of a real `find node_modules/.bun -name lib.dom.d.ts`; the tool name and input are written",
      },
      {
        mine: {
          file: `${OC}/0f6285e8-58cf-48fa-a7b7-37d29169c1b6/subagents/agent-ac82767d08572b818.jsonl`,
          tool: "Bash",
          match: { description: "List script dir" },
        },
        as: "LS",
        input: { path: `${CATALOG_CWD}/script` },
        why: "list: no `LS` call exists in any log. Output is the verbatim result of a real `ls script/`; the tool name and input are written",
      },
    ],
  },
  {
    label:
      "Edit tools. `edit`, `write` and `apply_patch` are the work set — two or more in a row fold into one work row, and each opens a real diff.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${OC}/0f6285e8-58cf-48fa-a7b7-37d29169c1b6.jsonl`,
          tool: "Edit",
          match: { file_path: "packages/wakes/src/wakes.ts", new_string: "`reclaimFiring` re-stamps the lease in" },
        },
      },
      {
        mine: {
          file: `${OC}/0a6a45ca-7899-448d-bc1e-3be4a20936b8.jsonl`,
          tool: "Write",
          match: { file_path: "workbench/workbench/pane-presentation.ts" },
        },
      },
      {
        part: applyPatchPart,
        why: "apply_patch: Claxedo's patch tool comes from Codex, and no Claude Code log contains one. The two files carry the real before/after text of the `Edit` and `Write` calls above",
      },
    ],
  },
  {
    label: "Shell. A run, a run whose output advertises a dev server, and a failure — the error card replaces the row.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${LOG_ROOT}/-Users-yashvardhansingh-test-agent-app-benchmark/a2ad53ea-72a6-49cf-90e6-34169605fea7.jsonl`,
          tool: "Bash",
          match: { description: "Check backup sizes" },
        },
      },
      {
        mine: {
          file: `${OC}/1f2870d3-197a-4f85-8e3a-fba548f02ba1.jsonl`,
          tool: "Bash",
          match: { description: "Diagnose why the app did not start" },
        },
      },
      {
        mine: {
          file: `${OC}/14975e8d-a163-43f7-9255-404ad23cfe98/subagents/agent-alane-platform-misc-ff10fffb84e934b5.jsonl`,
          tool: "Bash",
          match: { description: "Lint whatsapp socket" },
        },
      },
    ],
  },
  {
    label: "Web. `websearch` lists the links it found; `webfetch` is a link row with no body.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${OC}/1fd406e0-8055-43bf-a90b-48d6e79653aa/subagents/agent-a62ac6d3fb406fb79.jsonl`,
          tool: "WebSearch",
          match: { query: "@mariozechner/pi-agent-core npm" },
        },
      },
      {
        mine: {
          file: `${OC}/7f8843de-627f-4806-b86a-6b190ba730d1/subagents/workflows/wf_437befcf-567/agent-a59a7ffe20d16bda4.jsonl`,
          tool: "WebFetch",
          match: { url: "https://unpkg.com/remend@1.3.0/package.json" },
        },
      },
    ],
  },
  {
    label: "Subagents. Two spawns in a row collapse into the chip row.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${OC}/14975e8d-a163-43f7-9255-404ad23cfe98.jsonl`,
          tool: "Agent",
          match: { description: "Review lane ui" },
        },
      },
      {
        mine: {
          file: `${OC}/14975e8d-a163-43f7-9255-404ad23cfe98.jsonl`,
          tool: "Agent",
          match: { description: "Review lane infra" },
        },
      },
    ],
  },
  {
    label: "Subagents. A lone spawn keeps its own card.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${OC}/7f8843de-627f-4806-b86a-6b190ba730d1.jsonl`,
          tool: "Agent",
          match: { description: "Fix merge fallout in claxedo-app" },
        },
      },
    ],
  },
  {
    label: "MCP and skills. No renderer is registered for an `mcp__*` name, so both fall through to the generic row.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${LOG_ROOT}/-Users-yashvardhansingh-test-opencode--claude-worktrees-ci-prod-requirements-55b1a1/6bbffd3f-204c-400b-b153-cd001146e025.jsonl`,
          tool: "mcp__plugin_posthog_posthog__exec",
          match: { command: "call generate-app-url" },
        },
      },
      {
        mine: {
          file: `${OC}/389410cf-beb7-4bab-9e48-6aa0191c0e1c.jsonl`,
          tool: "mcp__ccd_session_mgmt__list_sessions",
          match: { limit: 8 },
        },
      },
      {
        mine: {
          file: `${OC}/0f6285e8-58cf-48fa-a7b7-37d29169c1b6.jsonl`,
          tool: "Skill",
          match: { skill: "code-review" },
        },
      },
    ],
  },
  {
    label: "Prompts. An answered question expands to its answers; a dismissed one collapses to a single line.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        mine: {
          file: `${LOG_ROOT}/-private-var-folders-t2-23hmqy6j43j7f3fg3m70gzhh0000gn-T-claxedo-desktop-claude-jabsNB/6600a28f-1289-46a5-b6c1-f9daefb70bd1.jsonl`,
          tool: "AskUserQuestion",
          match: { questions: "Which checks should run?" },
        },
      },
      {
        mine: {
          file: `${LOG_ROOT}/-private-var-folders-t2-23hmqy6j43j7f3fg3m70gzhh0000gn-T-claxedo-desktop-claude-FLn4H0/82c880bd-9ae4-4e52-9bb3-65873f05a57d.jsonl`,
          tool: "AskUserQuestion",
          match: { questions: "Which test environment?" },
        },
      },
    ],
  },
  {
    label:
      "Bookkeeping. `todowrite` is in the hidden set: `ToolPartDisplay` returns null for it, so this row is here to show that it renders nothing.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      {
        part: todoWritePart,
        why: "todowrite: no `TodoWrite` call exists in any log — this harness does not use it. Input and metadata are written to the `AgentTodo` shape",
      },
    ],
  },
  {
    label: "Rich text and reasoning.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    entries: [
      { think: { file: `${OC}/0a6a45ca-7899-448d-bc1e-3be4a20936b8.jsonl`, uuid: "658ec39d-18d7-4736-aa17-1a5e7c7b385b" } },
      { think: { file: `${OC}/0a6a45ca-7899-448d-bc1e-3be4a20936b8.jsonl`, uuid: "4381912f-971f-4dc0-983d-0fa6caac9a5d" } },
      { think: { file: `${OC}/0a6a45ca-7899-448d-bc1e-3be4a20936b8.jsonl`, uuid: "3415702c-4e95-48ea-af39-43a08f9e2302" } },
      { text: { file: `${OC}/6aa70587-bfa9-4098-be8c-ea3f1817cbf1.jsonl`, uuid: "40eee85b-37b9-4a20-9262-57f3af1db525" } },
    ],
  },
  {
    label: "Attachments and mentions. A data-URL attachment renders as a chip; a source-ranged file part and an agent part highlight inside the prompt text.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    userText: () => CATALOG_ATTACHMENT_TEXT,
    userParts: userAttachmentParts,
    userWhy:
      "user file/agent parts: the harness drops attachments into the log as image blocks, which this generator discards, and it emits no `agent` part at all. Built to the `AgentFilePart`/`AgentAgentPart` shapes",
    entries: [
      {
        part: linkFilePart,
        why: "assistant file part: no log carries a non-image assistant attachment. Built to the `AgentFilePart` shape so the link fallback renders",
      },
      {
        part: compactionPart,
        why: "compaction: the divider is a Claxedo construct the conversation codec inserts; a Claude Code log marks a compaction with `isCompactSummary` on an ordinary user row instead",
      },
    ],
  },
  {
    label: "Images. A screenshot on the prompt, and a `read` of an image file — each opens the full view on click.",
    why: "turn label: the catalogue is assembled, so its user prompts are written, not replayed",
    userParts: screenshotPromptParts,
    userWhy:
      "user image part: the `image/png` is the real screenshot sent with that prompt in 1f2870d3; the log sessions drop their image blocks, so this is the only place the surface appears",
    entries: [
      {
        mine: {
          file: `${OC}/1f2870d3-197a-4f85-8e3a-fba548f02ba1.jsonl`,
          tool: "Read",
          match: { file_path: "scratchpad/titles.png" },
        },
        why: "read of an image: the call, its path and its `image/png` result are real; `metadata.loaded` is OpenCode's field, absent from a Claude Code log, so it is derived from the path the read was given",
      },
    ],
  },
]

const catalogRowCache = new Map()

function catalogRows(file) {
  let rows = catalogRowCache.get(file)
  if (!rows) {
    rows = readRows(file, { rowsRead: 0, skipped: { unparsable: 0 } })
    catalogRowCache.set(file, rows)
  }
  return rows
}

function blocksOf(row) {
  const content = row?.message?.content
  return Array.isArray(content) ? content : []
}

/** A string criterion matches by substring so a pick can name a call by a readable fragment. */
function matchesInput(input, match) {
  for (const [key, expected] of Object.entries(match ?? {})) {
    const actual = input?.[key]
    if (typeof expected === "string") {
      if (!JSON.stringify(actual ?? "").includes(expected)) return false
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

function findCall(pick) {
  const rows = catalogRows(pick.file)
  const results = new Map()
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (block?.type === "tool_result" && !results.has(block.tool_use_id)) results.set(block.tool_use_id, { block, row })
    }
  }
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (block?.type !== "tool_use" || block.name !== pick.tool) continue
      if (!matchesInput(block.input, pick.match)) continue
      const result = results.get(block.id)
      if (!result) throw new Error(`no tool_result for ${pick.tool} ${block.id} in ${pick.file}`)
      return { block, row, result: result.block, resultRow: result.row }
    }
  }
  throw new Error(`no ${pick.tool} call matching ${JSON.stringify(pick.match)} in ${pick.file}`)
}

function findBlockText(pick, type) {
  for (const row of catalogRows(pick.file)) {
    if (row.uuid !== pick.uuid) continue
    for (const block of blocksOf(row)) {
      if (block?.type !== type) continue
      const text = type === "thinking" ? block.thinking : block.text
      if (typeof text === "string" && text.trim()) return { text: text.trim(), row }
    }
  }
  throw new Error(`no non-empty ${type} block on ${pick.uuid} in ${pick.file}`)
}

/**
 * The metadata each renderer reads, derived from the harness's own `toolUseResult`.
 * Without it `edit` shows no change counts, `question` never expands, and `task` has no
 * child id to link to.
 */
function catalogMetadata(tool, call, input) {
  const result = call.resultRow?.toolUseResult
  switch (tool) {
    case "edit": {
      const hunks = Array.isArray(result?.structuredPatch) ? result.structuredPatch : []
      const lines = hunks.flatMap((hunk) => (Array.isArray(hunk.lines) ? hunk.lines : []))
      if (!lines.length) return {}
      return {
        filediff: {
          file: input.filePath,
          before: input.oldString,
          after: input.newString,
          additions: lines.filter((line) => line.startsWith("+")).length,
          deletions: lines.filter((line) => line.startsWith("-")).length,
        },
      }
    }
    case "question":
      return questionMetadata(input, result)
    case "read": {
      // `loaded` is OpenCode's field; a Claude Code log has none, and a read that
      // answers with an image has loaded exactly the file it was pointed at.
      if (result?.type !== "image" || typeof input.filePath !== "string" || !input.filePath) return {}
      return { loaded: [input.filePath] }
    }
    case "task": {
      const id = result?.agent_id ?? result?.agentId
      return typeof id === "string" && id ? { sessionId: id } : {}
    }
    default:
      return {}
  }
}

function todoWritePart() {
  const todos = [
    { content: "Enumerate every part type the renderer dispatches", status: "completed", priority: "high" },
    { content: "Mine one real call per tool variant", status: "completed", priority: "high" },
    { content: "Hand-build the variants no log contains", status: "in_progress", priority: "medium" },
    { content: "Keep the fixture under the size budget", status: "pending", priority: "low" },
  ]
  return {
    type: "tool",
    callID: "catalog_todowrite",
    tool: "todowrite",
    state: {
      status: "completed",
      input: { todos },
      output: "Todos updated",
      title: "Update todos",
      metadata: { todos },
    },
  }
}

function applyPatchPart() {
  const edit = findCall({
    file: `${OC}/0f6285e8-58cf-48fa-a7b7-37d29169c1b6.jsonl`,
    tool: "Edit",
    match: { file_path: "packages/wakes/src/wakes.ts", new_string: "`reclaimFiring` re-stamps the lease in" },
  })
  const write = findCall({
    file: `${OC}/0a6a45ca-7899-448d-bc1e-3be4a20936b8.jsonl`,
    tool: "Write",
    match: { file_path: "workbench/workbench/pane-presentation.ts" },
  })
  const editLines = (edit.resultRow?.toolUseResult?.structuredPatch ?? []).flatMap((hunk) => hunk.lines ?? [])
  const created = String(write.block.input.content ?? "")
  const files = [
    {
      filePath: edit.block.input.file_path,
      relativePath: "packages/wakes/src/wakes.ts",
      type: "update",
      before: edit.block.input.old_string,
      after: edit.block.input.new_string,
      additions: editLines.filter((line) => line.startsWith("+")).length,
      deletions: editLines.filter((line) => line.startsWith("-")).length,
    },
    {
      filePath: write.block.input.file_path,
      relativePath: "packages/claxedo-app/src/app/workbench/workbench/pane-presentation.ts",
      type: "add",
      before: "",
      after: created,
      additions: created.split("\n").length,
      deletions: 0,
    },
  ]
  return {
    type: "tool",
    callID: "catalog_apply_patch",
    tool: "apply_patch",
    state: {
      status: "completed",
      input: { files: files.map((file) => file.relativePath) },
      output: "Applied patch to 2 files",
      title: "2 files",
      metadata: { files },
    },
  }
}

const CATALOG_ATTACHMENT_TEXT =
  "Follow @message-part.tsx and hand the sweep to @Explore — the acceptance list is attached."

function userAttachmentParts() {
  const mention = "@message-part.tsx"
  const agent = "@Explore"
  const mentionStart = CATALOG_ATTACHMENT_TEXT.indexOf(mention)
  const agentStart = CATALOG_ATTACHMENT_TEXT.indexOf(agent)
  const attachment = "Journey 1: open the lab and step through every turn.\n"
  return [
    {
      type: "file",
      mime: "text/plain",
      filename: "acceptance-journeys.md",
      url: `data:text/plain;base64,${Buffer.from(attachment, "utf8").toString("base64")}`,
    },
    {
      type: "file",
      mime: "text/plain",
      filename: "message-part.tsx",
      url: `file://${CATALOG_CWD}/packages/session-ui/src/components/message-part.tsx`,
      source: {
        type: "file",
        path: `${CATALOG_CWD}/packages/session-ui/src/components/message-part.tsx`,
        text: { value: mention, start: mentionStart, end: mentionStart + mention.length },
      },
    },
    {
      type: "agent",
      name: "Explore",
      source: { value: agent, start: agentStart, end: agentStart + agent.length },
    },
  ]
}

const SCREENSHOT_PROMPT = {
  file: `${OC}/1f2870d3-197a-4f85-8e3a-fba548f02ba1.jsonl`,
  uuid: "4a8b8d2c-d406-4281-98c8-e15e908964aa",
}

function findImageBlock(pick) {
  for (const row of catalogRows(pick.file)) {
    if (row.uuid !== pick.uuid) continue
    for (const block of blocksOf(row)) if (block?.type === "image") return block
  }
  throw new Error(`no image block on ${pick.uuid} in ${pick.file}`)
}

function screenshotPromptParts() {
  return [{ type: "file", filename: "content-shift.png", ...imageDataUrl(findImageBlock(SCREENSHOT_PROMPT)) }]
}

function linkFilePart() {
  return {
    type: "file",
    mime: "application/pdf",
    filename: "acp-opencode-mapping.pdf",
    url: "https://example.com/acp-opencode-mapping.pdf",
  }
}

function compactionPart() {
  return { type: "compaction", auto: true }
}

function buildCatalog() {
  const counters = {
    rowsRead: 0,
    skipped: {},
    imagesKept: 0,
    toolResults: { matched: 0, unmatched: 0 },
  }
  const messages = []
  const parts = {}
  const synthetic = []
  const stats = {
    userTurns: 0,
    assistantMessages: 0,
    textParts: 0,
    reasoningParts: 0,
    reasoningWithText: 0,
    toolParts: 0,
    proseChars: 0,
    machineryChars: 0,
  }
  let messageCount = 0
  let partCount = 0
  let clock = CATALOG_START
  const nextPartID = () => padID("p", (partCount += 1))
  const nextMessageID = () => padID("m", (messageCount += 1))
  const note = (id, why) => {
    if (why) synthetic.push(`${id}: ${why}`)
  }

  for (const turn of CATALOG_TURNS) {
    const userID = nextMessageID()
    const userText = turn.userText ? turn.userText() : turn.label
    messages.push({
      id: userID,
      sessionID: CATALOG_SESSION_ID,
      role: "user",
      time: { created: clock },
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    })
    const userTextID = nextPartID()
    parts[userID] = [
      {
        id: userTextID,
        sessionID: CATALOG_SESSION_ID,
        messageID: userID,
        type: "text",
        text: userText,
        time: { start: clock },
      },
    ]
    note(userTextID, turn.why)
    stats.userTurns += 1
    stats.textParts += 1
    stats.proseChars += userText.length
    for (const build of turn.userParts?.() ?? []) {
      const id = nextPartID()
      parts[userID].push({ id, sessionID: CATALOG_SESSION_ID, messageID: userID, ...build })
      note(id, turn.userWhy)
    }
    clock += CATALOG_GAP_MS

    const assistantID = nextMessageID()
    const assistant = {
      id: assistantID,
      sessionID: CATALOG_SESSION_ID,
      role: "assistant",
      time: { created: clock, completed: clock },
      parentID: userID,
      modelID: "claude-opus-5",
      providerID: "anthropic",
      mode: "default",
      agent: "claude",
      path: { cwd: CATALOG_CWD, root: CATALOG_CWD },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    messages.push(assistant)
    stats.assistantMessages += 1
    parts[assistantID] = []

    for (const entry of turn.entries) {
      const id = nextPartID()
      const base = { id, sessionID: CATALOG_SESSION_ID, messageID: assistantID }
      const start = clock

      if (entry.part) {
        clock = start + CATALOG_DEFAULT_DURATION_MS
        const built = entry.part()
        const part =
          built.type === "tool"
            ? { ...base, ...built, state: { ...built.state, time: { start, end: clock } } }
            : { ...base, ...built }
        parts[assistantID].push(part)
        note(id, entry.why)
        if (part.type === "tool") {
          stats.toolParts += 1
          stats.machineryChars += JSON.stringify(part.state.input).length
        }
        clock += CATALOG_GAP_MS
        continue
      }

      if (entry.text || entry.think) {
        const reasoning = !!entry.think
        const { text } = findBlockText(entry.text ?? entry.think, reasoning ? "thinking" : "text")
        clock = start + CATALOG_DEFAULT_DURATION_MS
        parts[assistantID].push({
          ...base,
          type: reasoning ? "reasoning" : "text",
          text,
          time: { start, end: clock },
        })
        if (reasoning) {
          stats.reasoningParts += 1
          stats.reasoningWithText += 1
          stats.machineryChars += text.length
        } else {
          stats.textParts += 1
          stats.proseChars += text.length
        }
        clock += CATALOG_GAP_MS
        continue
      }

      const call = findCall(entry.mine)
      counters.toolResults.matched += 1
      const tool = toolName(entry.as ?? call.block.name)
      const input = entry.input ? { ...entry.input } : toolInput(tool, call.block.input)
      const cwd = call.row.cwd ?? CATALOG_CWD
      const measured = Math.max(0, timeOf(call.resultRow) - timeOf(call.row))
      clock = start + (measured || CATALOG_DEFAULT_DURATION_MS)
      const images = []
      const output = truncate(flattenResult(call.result.content, images), CATALOG_OUTPUT_LIMIT)
      counters.imagesKept += images.length
      const title = toolTitle(tool, input, cwd)
      const metadata = catalogMetadata(tool, call, input)
      const attachments = images.map((block, index) => ({
        ...imageDataUrl(block),
        id: `${id}f${padID("", index + 1)}`,
        sessionID: CATALOG_SESSION_ID,
        messageID: assistantID,
        type: "file",
        filename: basename(String(input.filePath ?? title)),
      }))
      parts[assistantID].push({
        ...base,
        type: "tool",
        callID: call.block.id,
        tool,
        state: call.result.is_error
          ? { status: "error", input, error: output, metadata, time: { start, end: clock } }
          : {
              status: "completed",
              input,
              output,
              title,
              metadata,
              ...(attachments.length ? { attachments } : {}),
              time: { start, end: clock },
            },
      })
      if (entry.why) note(id, entry.why)
      stats.toolParts += 1
      stats.machineryChars += output.length + JSON.stringify(input).length
      clock += CATALOG_GAP_MS
    }

    assistant.time.completed = clock
  }

  return {
    session: {
      id: "catalog",
      title: "Parts catalog",
      sessionID: CATALOG_SESSION_ID,
      messages,
      parts,
      stats,
      synthetic,
    },
    counters,
  }
}

const argv = process.argv.slice(2)
const sources = SOURCES.map((source, index) =>
  argv[index] ? { ...source, file: resolve(argv[index]) } : source,
).concat(
  argv
    .slice(SOURCES.length)
    .map((file, index) => ({ id: `session${SOURCES.length + index + 1}`, file: resolve(file) })),
)

const sessions = []
for (const source of sources) {
  const { session, counters } = convert(source)
  sessions.push(session)
  const skipped = Object.entries(counters.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ")
  process.stderr.write(
    [
      `[${session.id}] ${basename(source.file)} "${session.title}"`,
      `  rows read: ${counters.rowsRead}${source.untilUuid ? ` (pinned at ${source.untilUuid})` : " (unpinned; live logs drift)"}; skipped: ${skipped || "none"}`,
      `  images dropped: ${counters.imagesDropped}`,
      `  tool results: matched=${counters.toolResults.matched} unmatched=${counters.toolResults.unmatched}`,
      `  messages: ${session.messages.length} (${session.stats.userTurns} user turns, ${session.stats.assistantMessages} assistant)`,
      `  parts: text=${session.stats.textParts} reasoning=${session.stats.reasoningParts} (${session.stats.reasoningWithText} with text) tool=${session.stats.toolParts}`,
      `  chars: prose=${session.stats.proseChars} machinery=${session.stats.machineryChars}`,
      "",
    ].join("\n"),
  )
}

{
  const { session, counters } = buildCatalog()
  sessions.push(session)
  const tools = {}
  for (const list of Object.values(session.parts))
    for (const part of list) if (part.type === "tool") tools[part.tool] = (tools[part.tool] ?? 0) + 1
  process.stderr.write(
    [
      `[${session.id}] assembled from ${catalogRowCache.size} logs "${session.title}"`,
      `  rows read: ${[...catalogRowCache.values()].reduce((total, rows) => total + rows.length, 0)}`,
      `  images kept: ${counters.imagesKept}`,
      `  tool results: matched=${counters.toolResults.matched} unmatched=${counters.toolResults.unmatched}`,
      `  messages: ${session.messages.length} (${session.stats.userTurns} user turns, ${session.stats.assistantMessages} assistant)`,
      `  parts: text=${session.stats.textParts} reasoning=${session.stats.reasoningParts} (${session.stats.reasoningWithText} with text) tool=${session.stats.toolParts}`,
      `  tools: ${Object.entries(tools)
        .map(([tool, count]) => `${tool}=${count}`)
        .join(" ")}`,
      `  chars: prose=${session.stats.proseChars} machinery=${session.stats.machineryChars}`,
      `  hand-built parts: ${session.synthetic.length}`,
      "",
    ].join("\n"),
  )
}

// One session per line: a diff then shows which session changed instead of one 1 MB blob.
writeFileSync(OUTPUT, `[\n${sessions.map((session) => JSON.stringify(session)).join(",\n")}\n]\n`)
process.stderr.write(`wrote ${OUTPUT} (${(statSync(OUTPUT).size / 1024).toFixed(1)} KB)\n`)
