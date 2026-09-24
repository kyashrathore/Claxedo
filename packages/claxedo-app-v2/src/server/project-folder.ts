import type { Server } from "./api"
import { toAppError } from "./errors"
import type { Project, ProjectSource } from "./types"

export async function createOrOpenFolderProject(server: Server, input: { readonly name?: string; readonly source: ProjectSource }): Promise<Project> {
  try {
    return await server.projects.create(input)
  } catch (error) {
    const source = input.source
    if (source.kind !== "folder" || toAppError(error).code !== "project_directory_taken") throw error
    const projects = await server.queryClient.fetchQuery({ ...server.queries.projects.list(), staleTime: 0 })
    const existing = projects.find((project) => project.directory === source.path)
    if (!existing) throw error
    return existing
  }
}
