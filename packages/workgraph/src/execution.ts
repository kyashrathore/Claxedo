export type ExecutionLaunch = {
  run_id: string
  node_id: string
  role: string
  kind: string
  title: string
  prompt: string
  directory?: string
  hidden?: boolean
}

export type ExecutionHandle = {
  id: string
  runtime_type?: string | null
  session_id?: string | null
  pty_id?: string | null
  directory?: string | null
  worktree_path?: string | null
}

export type ExecutionCleanup = {
  run_id: string
  node_id: string
  session_id?: string | null
  pty_id?: string | null
  directory?: string | null
  worktree_path?: string | null
  mode: "archive" | "delete"
}

export interface ExecutionAdapter {
  launch(input: ExecutionLaunch): Promise<ExecutionHandle>
  cleanup?(input: ExecutionCleanup): Promise<void>
}
