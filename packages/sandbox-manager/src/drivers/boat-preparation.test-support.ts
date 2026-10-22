/** What a Boat machine's preparation prints when the image its command names boots: that image, as the real script's last line. */
export function preparedImageOutput(command: string) {
  return `${/booted='([^']*)'/.exec(command)?.[1] ?? ""}\n`
}
