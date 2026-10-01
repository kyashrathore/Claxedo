import type { OwnedProcess } from "../contract"

const TAIL_LENGTH = 2_000
const ANSI = /\x1b\[[0-9;]*m/g

export class StderrTail {
  private text = ""

  constructor(process: OwnedProcess) {
    process.stderr.setEncoding("utf8")
    process.stderr.on("data", (chunk: string) => { this.text = `${this.text}${chunk.replace(ANSI, "")}`.slice(-TAIL_LENGTH) })
  }

  get value(): string { return this.text.trim() }
}
