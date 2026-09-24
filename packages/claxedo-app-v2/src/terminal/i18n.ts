import type { Translations } from "@/i18n"

const en = {
  "terminal.title": "Terminal",
  "terminal.title.numbered": "Terminal {{number}}",
  "terminal.connectionLost.title": "Connection lost",
  "terminal.connectionLost.description":
    "The terminal connection was interrupted. This can happen when the server restarts.",
  "terminal.connecting": "Connecting to the terminal",
  "terminal.reconnecting": "Reconnecting, attempt {{attempt}} of {{max}}",
  "terminal.retry": "Retry",
  "terminal.gone.title": "This terminal is no longer running",
  "terminal.gone.description": "Its history is kept. Start a new shell to continue in the same place.",
  "terminal.recreate": "Recreate terminal",
  "terminal.exited.title": "The shell exited",
  "terminal.exited.code": "Exit code {{code}}",
  "terminal.close": "Close terminal",
  "terminal.missing": "This terminal no longer exists",
  "terminal.overload":
    "The terminal produced too much output too quickly and was disconnected to keep the app responsive.",
  "terminal.restoreFailed": "The terminal's screen could not be restored.",
  "terminal.loadFailed": "The terminals could not be loaded.",
  "terminal.startFailed": "The terminal could not start in this window.",
  "terminal.createFailed": "The terminal could not be created.",
  "terminal.closeFailed": "The terminal could not be ended. Its shell may still be running.",
  "terminal.failed.title": "The terminal stopped",
  "terminal.agent.working": "Agent working",
  "terminal.agent.idle": "Agent idle",
  "terminal.agent.waitingOnUser": "Agent waiting on you",
  "terminal.agent.failed": "Agent failed",
  "terminal.keys": "Terminal keys",
  "terminal.key.escape": "Escape",
  "terminal.key.tab": "Tab",
  "terminal.key.control": "Control",
  "terminal.key.left": "Left arrow",
  "terminal.key.down": "Down arrow",
  "terminal.key.up": "Up arrow",
  "terminal.key.right": "Right arrow",
  "terminal.command.new": "New terminal",
  "terminal.command.new.description": "Create a new terminal tab",
  "terminal.command.toggle": "Toggle terminal",
  "terminal.pane": "Terminal pane",
}

export type TerminalKey = keyof typeof en

type Localized = Partial<Record<TerminalKey, string>>

const lost = (title: string, description: string): Localized => ({
  "terminal.connectionLost.title": title,
  "terminal.connectionLost.description": description,
})

const named = (title: string): Localized => ({
  "terminal.title": title,
  "terminal.title.numbered": `${title} {{number}}`,
})

export const dictionary = {
  en,
  ar: {
    ...named("محطة طرفية"),
    ...lost("فقد الاتصال", "انقطع اتصال المحطة الطرفية. يمكن أن يحدث هذا عند إعادة تشغيل الخادم."),
  },
  bs: lost("Veza prekinuta", "Veza s terminalom je prekinuta. Ovo se može desiti kada se server restartuje."),
  da: lost("Forbindelse mistet", "Terminalforbindelsen blev afbrudt. Dette kan ske, når serveren genstarter."),
  de: lost(
    "Verbindung verloren",
    "Die Terminalverbindung wurde unterbrochen. Das kann passieren, wenn der Server neu startet.",
  ),
  es: lost(
    "Conexión perdida",
    "La conexión del terminal se interrumpió. Esto puede ocurrir cuando el servidor se reinicia.",
  ),
  fr: lost(
    "Connexion perdue",
    "La connexion au terminal a été interrompue. Cela peut arriver lorsque le serveur redémarre.",
  ),
  ja: {
    ...named("ターミナル"),
    ...lost(
      "接続が失われました",
      "ターミナルの接続が中断されました。これはサーバーが再起動したときに発生することがあります。",
    ),
  },
  ko: {
    ...named("터미널"),
    ...lost("연결 끊김", "터미널 연결이 중단되었습니다. 서버가 재시작하면 이런 일이 발생할 수 있습니다."),
  },
  no: lost("Tilkobling mistet", "Terminalforbindelsen ble avbrutt. Dette kan skje når serveren starter på nytt."),
  pl: lost(
    "Utracono połączenie",
    "Połączenie z terminalem zostało przerwane. Może się to zdarzyć przy restarcie serwera.",
  ),
  br: lost(
    "Conexão Perdida",
    "A conexão do terminal foi interrompida. Isso pode acontecer quando o servidor reinicia.",
  ),
  ru: {
    ...named("Терминал"),
    ...lost("Соединение потеряно", "Соединение с терминалом прервано. Это может произойти при перезапуске сервера."),
  },
  th: {
    ...named("เทอร์มินัล"),
    ...lost("การเชื่อมต่อขาดหาย", "การเชื่อมต่อเทอร์มินัลถูกขัดจังหวะ อาจเกิดขึ้นเมื่อเซิร์ฟเวอร์รีสตาร์ท"),
  },
  tr: lost("Bağlantı Kesildi", "Terminal bağlantısı kesildi. Bu durum sunucu yeniden başladığında oluşabilir."),
  zh: { ...named("终端"), ...lost("连接已丢失", "终端连接已中断。这可能发生在服务器重启时。") },
  zht: { ...named("終端機"), ...lost("連線中斷", "終端機連線已中斷。這可能會在伺服器重新啟動時發生。") },
} satisfies Translations<TerminalKey>

export const defaultTitleTemplates: readonly string[] = Object.values(dictionary).flatMap((strings: Localized) => {
  const template = strings["terminal.title.numbered"]
  return template === undefined ? [] : [template]
})
