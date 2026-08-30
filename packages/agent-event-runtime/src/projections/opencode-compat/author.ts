import type {
  ClaxedoMessageAuthor,
  ClaxedoMessageInfoExtension,
} from "./types"
import type { AgentMessageInfo } from "@claxedo/agent-runtime-contract"

export function withClaxedoMessageAuthor<Info extends AgentMessageInfo>(
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
