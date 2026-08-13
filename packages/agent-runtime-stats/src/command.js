const INPUT_KEYS = ["command", "cmd", "script", "code"]

export function commandFrom(input) {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (parsed !== input) return commandFrom(parsed)
    } catch {}
    return input
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return ""
  for (const key of INPUT_KEYS) if (typeof input[key] === "string") return input[key]
  return commandFrom(input.input)
}

export function shellSegments(command) {
  const lines = command.split("\n")
  const kept = []
  let heredocEnd = null
  for (const line of lines) {
    if (heredocEnd) {
      if (line.trim() === heredocEnd) heredocEnd = null
      continue
    }
    kept.push(line)
    const heredoc = line.match(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/)
    if (heredoc) heredocEnd = heredoc[1]
  }
  command = kept.join("\n")
  const segments = []
  let current = ""
  let quote = null
  let escaped = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      current += character
      continue
    }
    const pair = command.slice(index, index + 2)
    if (pair === "&&" || pair === "||") {
      if (current.trim()) segments.push(current.trim())
      current = ""
      index++
      continue
    }
    if (character === "|" || character === ";" || character === "\n") {
      if (current.trim()) segments.push(current.trim())
      current = ""
      continue
    }
    current += character
  }
  if (current.trim()) segments.push(current.trim())
  return { segments, complete: quote === null && !escaped }
}

export function shellWords(segment) {
  const words = []
  let current = ""
  let quote = null
  let escaped = false
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }
    if (character === "#" && !current && (index === 0 || /\s/.test(segment[index - 1]))) break
    if (/\s/.test(character)) {
      if (current) words.push(current)
      current = ""
      continue
    }
    current += character
  }
  if (current) words.push(current)
  return { words, complete: quote === null && !escaped }
}
