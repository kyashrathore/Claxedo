import { queryOptions } from "@tanstack/solid-query"
import type { StarterPromptSignals } from "./starter-prompts"
import type { RuntimeDirectory } from "@/platform/runtime/agent/placement-table"

type StarterPromptClient = {
  find: {
    files(input: { directory: RuntimeDirectory; query: string; type: "file"; limit: number }): Promise<{ data?: string[] }>
    text(input: { directory: RuntimeDirectory; pattern: string }): Promise<{
      data?: { path: { text: string }; lines: { text: string }; line_number: number }[]
    }>
  }
  file: {
    read(input: { directory: RuntimeDirectory; path: string }): Promise<{ data?: { type: "text" | "binary"; content: string } }>
  }
}

export function starterPromptQuery(input: { client: StarterPromptClient; directory: RuntimeDirectory }) {
  return queryOptions({
    queryKey: ["onboarding", "starter-prompts", input.directory] as const,
    staleTime: Infinity,
    queryFn: () => loadStarterPromptSignals(input),
  })
}

export async function loadStarterPromptSignals(input: {
  client: StarterPromptClient
  directory: RuntimeDirectory
}): Promise<StarterPromptSignals> {
  const files = await input.client.find.files({
    directory: input.directory,
    query: "",
    type: "file",
    limit: 200,
  }).then((result) => result.data ?? []).catch(() => [])
  const readme = files
    .filter((file) => /(^|\/)readme(?:\.[^/]*)?$/i.test(file))
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))[0]
  const [content, matches] = await Promise.all([
    readme
      ? input.client.file.read({ directory: input.directory, path: readme }).then((result) =>
          result.data?.type === "text" ? result.data.content : undefined,
        ).catch(() => undefined)
      : undefined,
    input.client.find.text({ directory: input.directory, pattern: "\\bTODO\\b" }).then((result) => result.data ?? []).catch(() => []),
  ])
  return {
    files,
    ...(content ? { readme: content } : {}),
    todos: matches.slice(0, 1).map((match) => ({
      path: match.path.text,
      line: match.line_number,
      text: match.lines.text,
    })),
  }
}
