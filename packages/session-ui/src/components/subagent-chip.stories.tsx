import type { ParentProps } from "solid-js"
import { DataProvider, type SubagentView } from "../context"
import { SubagentChipRow } from "./subagent-chip"

/* SubagentChipRow reads the Data context even when `subagents` is passed directly. */
function Harness(props: ParentProps) {
  return (
    <DataProvider
      data={{
        session: [
          { id: "ses_story", projectID: "story", directory: "/", title: "Story", time: { created: 0, updated: 0 } },
        ],
        session_status: {},
        session_diff: {},
        message: {},
        part: {},
      }}
      directory="/"
    >
      {props.children}
    </DataProvider>
  )
}

export default {
  title: "UI/SubagentChipRow",
  id: "components-subagent-chip-row",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: `### Overview
Consecutive subagent spawns collapse into one chip row. The row shows the first three
and puts the rest behind a toggle, so a fan-out of ten agents stays one line until asked.`,
      },
    },
  },
}

function subagentView(name: string, status: SubagentView["status"], description: string): SubagentView {
  return {
    parentSessionId: "ses_story",
    subagentKey: `call_${name}`,
    toolCallRole: "spawn",
    mode: "foreground",
    status,
    label: name,
    agentLabel: name,
    description,
    childSessionId: `ses_${name}`,
    transcriptKind: "none",
    resolution: "ready",
    ambient: false,
  }
}

const MANY = [
  subagentView("Explore", "completed", "Map the render path"),
  subagentView("Plan", "completed", "Draft the migration"),
  subagentView("general-purpose", "running", "Mine the fixture"),
  subagentView("Review", "completed", "Check the diff"),
  subagentView("Explore", "failed", "Survey the harnesses"),
]

export const Overflow = {
  name: "More than three (toggles)",
  render: () => (
    <Harness>
      <SubagentChipRow subagents={MANY} />
    </Harness>
  ),
}

export const Exactly3 = {
  name: "Exactly three (no toggle)",
  render: () => (
    <Harness>
      <SubagentChipRow subagents={MANY.slice(0, 3)} />
    </Harness>
  ),
}

export const Single = {
  render: () => (
    <Harness>
      <SubagentChipRow subagents={MANY.slice(0, 1)} />
    </Harness>
  ),
}
