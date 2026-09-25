import type { UserAgentConfig } from "./config"

export type UserAgentConfigRepository = {
  read(userId: string): Promise<UserAgentConfig>
  write(userId: string, config: UserAgentConfig): Promise<void>
}

export type UserAgentConfigStore = {
  read(): Promise<UserAgentConfig>
  write(config: UserAgentConfig): Promise<void>
}

export function userAgentConfigStore(repository: UserAgentConfigRepository, userId: string): UserAgentConfigStore {
  return {
    read: () => repository.read(userId),
    write: (config: UserAgentConfig) => repository.write(userId, config),
  }
}
