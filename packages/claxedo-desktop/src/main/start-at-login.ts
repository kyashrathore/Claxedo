type LoginItemApp = {
  getLoginItemSettings(): { openAtLogin: boolean }
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
}

export function createStartAtLogin(app: LoginItemApp) {
  return {
    get: () => app.getLoginItemSettings().openAtLogin,
    set: (enabled: boolean) => app.setLoginItemSettings({ openAtLogin: enabled }),
  }
}
