import type {
  ClaxedoMessageAuthor,
  ClaxedoMessageInfoExtension,
  EventMessageUpdated,
} from "./types"

export function withClaxedoMessageAuthor<Info extends EventMessageUpdated["properties"]["info"]>(
  info: Info,
  author?: ClaxedoMessageAuthor,
): Info & ClaxedoMessageInfoExtension {
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
