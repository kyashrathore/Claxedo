/** The Standup page the demo's agent builds, shown in the app demo and in the home page's crops. */
export const standup = [
  {
    project: "Claxedo",
    yesterday: [
      { text: "Fixed the usage meter: it keeps the latest total, 118,204 tokens against the dashboard's 118k", from: "Fix usage meter · Codex" },
      { text: "Rotated relay tokens to EdDSA; the old verifier stays for one release", from: "Rotate relay tokens · Codex · Daytona sandbox" },
    ],
    today: [{ text: "Drafting this week's release notes from 14 merged pull requests", from: "Draft release notes · Cursor · studio-mac" }],
    blocked: [{ text: "Permission bump for box-1 needs your approval", from: "Tasks · #13" }],
  },
  {
    project: "formlink",
    yesterday: [{ text: "Mapped the three validators that disagree on required fields", from: "What is this project? · OpenCode" }],
    today: [{ text: "Make the shared schema the only validator", from: "What is this project? · OpenCode" }],
    blocked: [],
  },
] as const
