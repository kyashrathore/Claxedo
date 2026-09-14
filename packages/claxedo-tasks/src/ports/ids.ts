/** Row identities are host-minted so an adapter can use its own id shape. */
export type TasksIdsPort = {
  presetId(): string
  taskId(): string
}
