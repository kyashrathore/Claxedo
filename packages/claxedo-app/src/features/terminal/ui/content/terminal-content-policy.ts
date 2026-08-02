export function shouldMountTerminalPane(input: { visible: boolean; ptyReady: boolean; activated: boolean }) {
  return input.ptyReady && (input.visible || input.activated)
}
