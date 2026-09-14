import { For, type ParentProps } from "solid-js"
import type { AgentAssistantMessage, AgentToolPart, AgentToolState } from "@claxedo/agent-runtime-contract"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { DataProvider, type SubagentView } from "../context"
import { Part } from "./message-part"
import { FileStub } from "./story-stubs"

const SESSION = "ses_story"
const TASK_ID = "tsk_4f4ff3c1-558e-4d87-a286-91d576421af5"

const message: AgentAssistantMessage = {
  id: "msg_story",
  sessionID: SESSION,
  role: "assistant",
  time: { created: 1 },
  parentID: "msg_user",
  modelID: "claude-opus-5",
  providerID: "anthropic",
  mode: "default",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
}

let seq = 0

function tool(name: string, state: AgentToolState): AgentToolPart {
  seq += 1
  return { id: `prt_${seq}`, sessionID: SESSION, messageID: message.id, type: "tool", callID: `call_${seq}`, tool: name, state }
}

function done(input: Record<string, unknown>, output: unknown): AgentToolState {
  return {
    status: "completed",
    input,
    output: typeof output === "string" ? output : JSON.stringify(output, null, 2),
    title: "",
    metadata: {},
    time: { start: 1, end: 2 },
  }
}

const child: SubagentView = {
  parentSessionId: SESSION,
  subagentKey: "sub_review",
  toolCallRole: "spawn",
  status: "running",
  label: "Reviewer",
  agentLabel: "Reviewer",
  description: "Review the diff for missed error paths",
  childSessionId: "ses_child",
  transcriptKind: "live",
  resolution: "ready",
  ambient: false,
}

function ClaxedoToolHarness(props: ParentProps) {
  return (
    <FileComponentProvider component={FileStub}>
      <DataProvider
        data={{
          session: [
            { id: "ses_tasks_1", projectID: "story", directory: "/", title: "MCP tasks smoke", time: { created: 0, updated: 0 } },
          ],
          session_status: {},
          session_diff: {},
          message: {},
          part: {},
        }}
        directory="/"
        onSessionHref={(id) => `/s/${id}`}
        onTaskHref={(id) => `/tasks/${id}`}
        resolveSubagents={() => [child]}
      >
        <div style={{ width: "720px", display: "flex", "flex-direction": "column", gap: "4px" }}>{props.children}</div>
      </DataProvider>
    </FileComponentProvider>
  )
}

const PARTS: Array<{ part: AgentToolPart; open?: boolean }> = [
  { part: tool("bash", done({ command: "bun test src" }, "309 pass")) },
  {
    part: tool("mcp__claxedo__task_create", done(
      { title: "MCP smoke: created from a session", status: "backlog", intent: "mcp" },
      { task: { id: TASK_ID, number: 5, title: "MCP smoke: created from a session", status: "backlog", parent: null, project: "prj", createdFrom: { sessionId: "ses_tasks_1", workspaceId: "w" } }, replayed: false },
    )),
  },
  {
    part: tool("mcp__claxedo__task_start", done(
      { task: TASK_ID, preset: "Alt voice", intent: "mcp" },
      {
        session: { sessionId: "ses_tasks_1", workspaceId: "w" },
        slot: "primary",
        attempt: 1,
        preset: { id: "tpr_1", name: "Alt voice" },
        placement: "local",
        destination: "/private/tmp/demo-project, with that workspace's own skills and plugins",
        created: true,
      },
    )),
    open: true,
  },
  {
    part: tool("mcp__claxedo__task_start", {
      status: "error",
      input: { task: TASK_ID, preset: "Alt voice", intent: "mcp" },
      error: "Starting a task's session from inside a session needs the account setting that lets agents act on other machines",
      time: { start: 1, end: 2 },
    }),
    open: true,
  },
  {
    part: tool("mcp__claxedo__task_list", done(
      { status: "todo", intent: "mcp" },
      {
        project: "prj",
        tasks: [
          { id: "tsk_1", number: 1, title: "Wire the credential broker", status: "doing" },
          { id: "tsk_2", number: 2, title: "Land the tasks preset picker", status: "todo" },
          { id: "tsk_3", number: 3, title: "Rename session tags", status: "needs_you" },
          { id: "tsk_4", number: 4, title: "Retire the /share command", status: "done" },
        ],
        nextCursor: null,
      },
    )),
    open: true,
  },
  { part: tool("claxedo_task_create", { status: "running", input: { title: "Fix the clip" }, time: { start: Date.now() } }) },
  { part: tool("task_send_placeholder", done({}, "")) },
  {
    part: tool("mcp__claxedo__session_send", done(
      { session: "ses_tasks_1", text: "Please rerun the tests and report the counts", intent: "mcp" },
      { session: "ses_tasks_1", admitted: true },
    )),
  },
  {
    part: tool("mcp__claxedo__create_subagent", done(
      { configuration: "review", prompt: "Review the diff", model: { providerID: "anthropic", id: "claude-opus-5" }, effort: "high", mode: "async", intent: "task" },
      { kind: "claxedo.subagent", subagentKey: "sub_review", sessionId: "ses_child", status: "running" },
    )),
  },
]

function ClaxedoToolGallery() {
  return (
    <For each={PARTS.filter((entry) => entry.part.tool !== "task_send_placeholder")}>
      {(entry) => <Part part={entry.part} message={message} defaultOpen={entry.open} />}
    </For>
  )
}

export default {
  title: "UI/ClaxedoTool",
  id: "components-claxedo-tool",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: "First-party Claxedo MCP calls as transcript rows: the Claxedo mark, the verb, the task or session as a link, a status pill, and a body of facts or rows.",
      },
    },
  },
}

export const Basic = {
  name: "Gallery",
  render: () => (
    <ClaxedoToolHarness>
      <ClaxedoToolGallery />
    </ClaxedoToolHarness>
  ),
}
