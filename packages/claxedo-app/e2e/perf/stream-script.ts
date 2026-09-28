import path from "node:path"
import type { AcpScript, AcpStep } from "../../../harness/e2e/harness/acp/script"

export const STREAM_END = "Stream finished: all checks pass."

const CHUNK_CHARS = 8
const CHUNK_DELAY_MS = 25

function paced(text: string, chunkChars = CHUNK_CHARS): AcpStep {
  return { kind: "text", text, chunks: Math.ceil(text.length / chunkChars), delayMs: CHUNK_DELAY_MS }
}

function lines(count: number, make: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => make(index)).join("\n")
}

const TS_BLOCK = [
  "```ts",
  "export type Delta = { messageId: string; partId: string; field: string; text: string }",
  "",
  "export function coalesce(deltas: readonly Delta[]): Map<string, Delta> {",
  "  const out = new Map<string, Delta>()",
  "  for (const delta of deltas) {",
  "    const key = `${delta.messageId}:${delta.partId}:${delta.field}`",
  "    const current = out.get(key)",
  "    if (current) current.text += delta.text",
  "    else out.set(key, { ...delta })",
  "  }",
  "  return out",
  "}",
  "",
  lines(14, (i) => `export const limit${i} = ${i * 17} // bucket ${i}`),
  "```",
].join("\n")

const BASH_BLOCK = ["```bash", "set -euo pipefail", lines(10, (i) => `bun test src/module-${i}.test.ts --timeout 20000 | tee -a log/run-${i}.txt`), "```"].join("\n")

const JSON_BLOCK = ["```json", "{", lines(18, (i) => `  "entry${i}": { "id": ${i}, "enabled": ${i % 2 === 0}, "label": "Entry number ${i}" },`), '  "last": true', "}", "```"].join("\n")

const PY_BLOCK = [
  "```python",
  "def summarize(rows):",
  "    totals = {}",
  "    for row in rows:",
  "        totals[row['kind']] = totals.get(row['kind'], 0) + row['ms']",
  "    return sorted(totals.items(), key=lambda item: -item[1])",
  "",
  lines(10, (i) => `print(summarize([{'kind': 'k${i}', 'ms': ${i * 3}}]))`),
  "```",
].join("\n")

const TSX_BLOCK = [
  "```tsx",
  "export function Row(props: { title: string; count: number }) {",
  "  return (",
  '    <div class="row">',
  "      <span>{props.title}</span>",
  "      <strong>{props.count}</strong>",
  "    </div>",
  "  )",
  "}",
  lines(8, (i) => `export const Row${i} = () => <Row title="row ${i}" count={${i}} />`),
  "```",
].join("\n")

const MERMAID_BLOCK = [
  "```mermaid",
  "flowchart LR",
  "  A[Stream frame] --> B[Delta buffer]",
  "  B --> C[Store commit]",
  "  C --> D[Markdown projection]",
  "  D --> E[Block render]",
  "  E --> F[Paint]",
  "  C --> G[Virtualizer measure]",
  "  G --> F",
  "```",
].join("\n")

const TABLE = [
  "| Stage | Owner | Cost per delta | Notes |",
  "| --- | --- | ---: | --- |",
  lines(12, (i) => `| stage ${i} | module-${i} | ${(i * 0.37).toFixed(2)} ms | keeps \`state-${i}\` in step with **the store** |`),
].join("\n")

function prose(topic: string, paragraphs: number) {
  return lines(
    paragraphs,
    (i) =>
      `The ${topic} step ${i + 1} reads the current state, compares it with the previous frame, and writes only what changed. ` +
      `It keeps **bold facts**, \`inline code\`, and [a link](https://example.com/${topic}/${i}) in the same paragraph, so the renderer sees mixed inline content. ` +
      `A careful reader can follow each claim back to the source file without guessing.\n`,
  )
}

function list(topic: string, items: number) {
  return lines(items, (i) => `${i + 1}. **${topic} ${i + 1}**: check the \`${topic}-${i}\` path, then confirm the result\n   - nested detail ${i} with *emphasis*`)
}

const SHELL_OUTPUT = lines(80, (i) => `  ✓ src/module-${i}.test.ts > case ${i} passes [${(i * 1.7).toFixed(1)} ms]`)

const OLD_FILE = lines(40, (i) => `export const value${i} = ${i}`) + "\n"
const NEW_FILE = lines(40, (i) => (i % 5 === 0 ? `export const value${i} = ${i} * 2 // doubled` : `export const value${i} = ${i}`)) + "\n"

export function streamScript(directory: string): AcpScript {
  const file = path.join(directory, "src/values.ts")
  return {
    steps: [
      { kind: "reasoning", text: "Planning a long answer with code, a table, a diagram and several tool calls." },
      paced(["# Streaming report", "", "## Overview", "", prose("overview", 3), "", list("Check", 6), "", TS_BLOCK, "", prose("buffer", 2)].join("\n")),
      { kind: "tool", tool: "execute", title: "bun test", input: { command: "bun test" }, text: SHELL_OUTPUT },
      paced(["## Test results", "", prose("results", 2), "", BASH_BLOCK, "", TABLE, "", prose("table", 2)].join("\n")),
      { kind: "diff", path: file, oldText: OLD_FILE, newText: NEW_FILE },
      paced(["## The edit", "", prose("edit", 2), "", JSON_BLOCK, "", list("Follow-up", 5), "", MERMAID_BLOCK, "", prose("diagram", 2)].join("\n")),
      { kind: "tool", tool: "read", title: "Read src/values.ts", locations: [{ path: file }], text: NEW_FILE },
      { kind: "tool", tool: "search", title: "Search for value", input: { pattern: "value" }, text: lines(30, (i) => `src/values.ts:${i + 1}: export const value${i}`) },
      paced(["## Wrap-up", "", prose("wrap", 2), "", PY_BLOCK, "", TSX_BLOCK, "", list("Next", 4), "", STREAM_END].join("\n")),
    ],
  }
}

export function seedTurnScript(directory: string, turn: number): AcpScript {
  const file = path.join(directory, "src/values.ts")
  const reply = [
    `### Earlier turn ${turn}`,
    "",
    prose(`seed-${turn}`, 2),
    "",
    list(`Seed ${turn}`, 3),
    "",
    "```ts",
    lines(8, (i) => `export const seed${turn}_${i} = ${i} // turn ${turn}`),
    "```",
    "",
    `Seed turn ${turn} done.`,
  ].join("\n")
  return {
    steps: [
      { kind: "reasoning", text: `Thinking about turn ${turn}` },
      { kind: "tool", tool: "read", title: `Read src/values.ts (${turn})`, locations: [{ path: file }], text: OLD_FILE },
      { kind: "tool", tool: "execute", title: `git status (${turn})`, input: { command: "git status --short" }, text: " M src/values.ts" },
      { kind: "text", text: reply, chunks: 3 },
    ],
  }
}

export function longReplyScript(directory: string): AcpScript {
  const segments = streamScript(directory).steps.flatMap((step) => (step.kind === "text" ? [step.text.replace(STREAM_END, "")] : []))
  const body = [...segments, ...segments].join("\n\n")
  return { steps: [{ kind: "reasoning", text: "One long answer." }, paced(`${body}\n\n${STREAM_END}`, 16)] }
}
