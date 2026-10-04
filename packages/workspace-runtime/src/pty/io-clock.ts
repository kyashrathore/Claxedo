let lastIoAt = 0

/** When any terminal in this process last carried input or output; an open but quiet shell leaves it alone. */
export const terminalIo = {
  touch() {
    lastIoAt = Date.now()
  },
  lastAt: () => lastIoAt,
}
