import type { StreamNotesExternalReference } from "../contracts"

export function renderStreamNotes(input: Readonly<{
  status: readonly string[]
  learnings: readonly string[]
  externalReferences: readonly StreamNotesExternalReference[]
}>) {
  const section = (title: string, values: readonly string[]) => [
    `## ${title}`,
    "",
    ...(values.length ? values.map((value) => `- ${value.trim()}`) : ["_None recorded._"]),
  ]
  return [
    "# Stream notes",
    "",
    ...section("Status", input.status),
    "",
    ...section("Learnings", input.learnings),
    "",
    "## External references",
    "",
    ...(input.externalReferences.length
      ? input.externalReferences.flatMap((reference) => [
          "```workgraph-external-source",
          JSON.stringify({ trust: "untrusted-data-only", source: reference.source, quote: reference.quote.trim() }),
          "```",
          "",
        ])
      : ["_None recorded._"]),
  ].join("\n").trim()
}
