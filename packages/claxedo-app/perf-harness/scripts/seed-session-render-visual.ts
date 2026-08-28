import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { materializeClaxedoCorpus } from "../src/agent-corpus-materializer"

const root = path.resolve(import.meta.dir, "../../../..")
const outDir = path.join(root, ".artifacts/session-render-visual-profile")
const corpusPath = path.join(outDir, "corpus.json")
const dataDirectory = path.join(outDir, "data")
const workspaceDirectory = path.join(outDir, "workspace")

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}

function session(input: {
  order: number
  title: string
  user: string
  assistantType: "markdown" | "code" | "table" | "mermaid" | "diff"
  assistant: Record<string, unknown>
}) {
  return {
    id: `visual-${String(input.order).padStart(2, "0")}`,
    title: input.title,
    order: input.order,
    events: [],
    terminalStreams: [],
    turns: [
      {
        id: `turn-${input.order}`,
        index: 0,
        messages: [
          {
            id: `user-${input.order}`,
            order: 0,
            role: "user" as const,
            parts: [{ id: `prompt-${input.order}`, order: 0, type: "text", text: input.user }],
          },
          {
            id: `assistant-${input.order}`,
            order: 1,
            role: "assistant" as const,
            parts: [{ id: `answer-${input.order}`, order: 0, ...input.assistant }],
          },
        ],
      },
    ],
  }
}

const payload = {
  schemaVersion: 1 as const,
  kind: "agent-app-corpus" as const,
  corpusId: "session-render-visual-v1",
  source: "generated-public" as const,
  seed: "session-render-visual-v1",
  sessions: [
    session({
      order: 0,
      title: "Markdown headings",
      user: "Write the implementation plan as headings and lists.",
      assistantType: "markdown",
      assistant: {
        type: "markdown",
        markdown: `# Implementation Plan

## Schema
- Add the new fields
- Keep the existing primary key

## API
1. Validate the payload
2. Persist the record
3. Return the created id

> This session is headings and lists only — switch to the next session for a large TypeScript block.`,
      },
    }),
    session({
      order: 1,
      title: "TypeScript code",
      user: "Show the TypeScript helper with a fenced code block.",
      assistantType: "code",
      assistant: {
        type: "code",
        language: "typescript",
        code: `export function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

export function average(values: number[]) {
  if (values.length === 0) return 0
  return sum(values) / values.length
}

export function rollingAverage(values: number[], window: number) {
  if (window <= 0) throw new Error("window must be positive")
  return values.map((_, index) => average(values.slice(Math.max(0, index + 1 - window), index + 1)))
}`,
      },
    }),
    session({
      order: 2,
      title: "Comparison table",
      user: "Give me a markdown table comparing before and after.",
      assistantType: "table",
      assistant: {
        type: "table",
        headers: ["Feature", "Before", "After"],
        rows: [
          ["Speed", "120ms", "45ms"],
          ["Memory", "256MB", "128MB"],
          ["Bundle", "1.2MB", "890KB"],
          ["First paint", "plain text flash", "rich markdown"],
        ],
      },
    }),
    session({
      order: 3,
      title: "Mermaid flowchart",
      user: "Draw the session-switch flow as a mermaid diagram.",
      assistantType: "mermaid",
      assistant: {
        type: "markdown",
        markdown: `Here is the session-switch path as a diagram — this session should look nothing like the table or code sessions.

\`\`\`mermaid
flowchart TD
  A[Click session B] --> B[Remember panel for A]
  B --> C[Restore panel for B]
  C --> D{First visit?}
  D -->|yes| E[Keep panel closed]
  D -->|no| F[Reopen Files or Changes]
  E --> G[Paint rich markdown]
  F --> G
\`\`\`
`,
      },
    }),
    session({
      order: 4,
      title: "File diff",
      user: "Show the patch for markdown-rich-stage.ts.",
      assistantType: "diff",
      assistant: {
        type: "diff",
        path: "packages/session-ui/src/components/markdown-rich-stage.ts",
        patch: `@@ -44,11 +44,7 @@ export function shouldStageCompletedMarkdown(input: {
   if (input.streaming) return false
   if (input.delayMs <= 0) return false
   if (!input.text) return false
-  return !hasCompletedMarkdownPaint(input.cacheKey, input.text)
+  return false
 }`,
      },
    }),
  ],
}

const digest = createHash("sha256").update(JSON.stringify(sortJson(payload))).digest("hex")
const corpus = {
  ...payload,
  manifest: {
    counts: {
      sessions: payload.sessions.length,
      turns: payload.sessions.length,
    },
    hashes: {
      corpusSha256: digest,
      semanticSha256: digest,
      terminalSha256: digest,
    },
  },
}

await mkdir(outDir, { recursive: true, mode: 0o700 })
await writeFile(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`)
await materializeClaxedoCorpus({
  corpusPath,
  corpusDigestSha256: digest,
  dataDirectory,
  workspaceDirectory,
  profiles: [],
})

console.log(`Seeded ${corpus.sessions.length} visually distinct sessions.`)
console.log(`  data: ${dataDirectory}`)
console.log(`  workspace: ${workspaceDirectory}`)
console.log("Titles: Markdown headings / TypeScript code / Comparison table / Mermaid flowchart / File diff")
