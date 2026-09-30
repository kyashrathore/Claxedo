export const PI_VERSION = "0.85.1"
export const CODEX_VERSION = "0.156.1"

export const SESSION_TITLE_SYSTEM_PROMPT = [
  "Generate a concise, single-line title of at most 60 characters and under six words where possible for the coding conversation the user provides.",
  "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise.",
  "Preserve ticket references and code identifiers exactly. Write in the user's language.",
  "Do not use quotes, markdown, or trailing punctuation. Do not answer the request. Reply with the title only.",
].join(" ")
