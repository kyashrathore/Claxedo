import type { AgentMessageInfo } from "./content"
import type { AgentMessageAuthor } from "./sessions"

export function withClaxedoMessageAuthor<Info extends AgentMessageInfo>(
  info: Info,
  author?: AgentMessageAuthor,
): Info & { claxedo?: { author: AgentMessageAuthor } } {
  if (!author || info.role !== "user") return info
  return {
    ...info,
    claxedo: {
      author: {
        id: author.id,
        name: author.name,
        ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
        kind: author.kind,
      },
    },
  }
}
