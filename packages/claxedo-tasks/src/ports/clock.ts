/** Every persisted timestamp in this kit comes from here, never from the adapter's own write time. */
export type TasksClockPort = {
  now(): number
}
