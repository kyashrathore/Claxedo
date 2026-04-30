export const disposeMode = (input: { managed: boolean; exited: boolean }) =>
  input.managed || input.exited ? "exit" : "remove"
