export type StarterPromptSignals = {
  files: string[]
  readme?: string
  todos: { path: string; line: number; text: string }[]
}

const staticPrompts = ["Explain how this codebase is organized", "Find and fix a TODO"] as const
const languages: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", rb: "Ruby",
  rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", swift: "Swift", cs: "C#", cpp: "C++", cc: "C++", c: "C", php: "PHP",
}

export function createStarterPrompts(signals: StarterPromptSignals): [string, string, string] {
  return [...staticPrompts, repoPrompt(signals)]
}

function repoPrompt(signals: StarterPromptSignals) {
  const heading = signals.readme?.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1]?.replace(/[*_`[\]]/g, "").trim()
  if (heading) return `Show me how ${heading} is implemented`

  const todo = signals.todos[0]
  if (todo) {
    const text = todo.text.replace(/^.*?\bTODO\b\s*:?[ \t]*/i, "").trim()
    return `Handle the TODO in ${todo.path}:${todo.line}${text ? `: ${text}` : ""}`
  }

  const counts = signals.files.reduce((result, file) => {
    const extension = file.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
    const language = extension ? languages[extension] : undefined
    if (language) result.set(language, (result.get(language) ?? 0) + 1)
    return result
  }, new Map<string, number>())
  const language = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0]
  if (language) return `Trace the main ${language} execution path`
  return "Identify the best place to make a small first improvement"
}
