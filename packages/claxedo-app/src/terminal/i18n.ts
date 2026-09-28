import type { Translations } from "@/i18n"

const en = {
  "terminal.title": "Terminal",
  "terminal.connectionLost.title": "Connection Lost",
  "terminal.connectionLost.description":
    "The terminal connection was interrupted. This can happen when the server restarts.",
  "terminal.retry": "Retry",
  "terminal.overload.title": "Terminal output overflow",
  "terminal.overload":
    "This terminal produced too much output too quickly. It has been disconnected to keep the app responsive.",
  "terminal.restoreFailed": "Terminal restore failed",
  "terminal.startFailed.title": "Terminal failed to start",
  "terminal.createFailed": "The terminal could not be created.",
  "terminal.closeFailed": "The terminal could not be ended. Its shell may still be running.",
  "terminal.keys": "Terminal keys",
  "terminal.key.escape": "Escape",
  "terminal.key.tab": "Tab",
  "terminal.key.control": "Control",
  "terminal.key.left": "Left arrow",
  "terminal.key.down": "Down arrow",
  "terminal.key.up": "Up arrow",
  "terminal.key.right": "Right arrow",
  "terminal.command.new": "New terminal",
  "terminal.creator.tab": "New Terminal",
  "terminal.creator.title": "Start a terminal",
  "terminal.creator.inNewWorktree": "· in a new worktree",
  "terminal.creator.inNewSandbox": "· in a new cloud sandbox",
  "terminal.creator.shell": "Shell",
  "terminal.creator.loginShell": "login shell",
  "terminal.creator.starting": "Starting…",
  "terminal.command.new.description": "Create a new terminal tab",
  "terminal.command.toggle": "Toggle terminal",
  "terminal.pane": "Terminal pane",
}

export type TerminalKey = keyof typeof en

type Localized = Partial<Record<TerminalKey, string>>

const connectionLost = (title: string, description: string): Localized => ({
  "terminal.connectionLost.title": title,
  "terminal.connectionLost.description": description,
})

const named = (title: string): Localized => ({
  "terminal.title": title,
})

export const terminalDictionary = {
  en,
  ar: {
    ...named("محطة طرفية"),
    ...connectionLost("فقد الاتصال", "انقطع اتصال المحطة الطرفية. يمكن أن يحدث هذا عند إعادة تشغيل الخادم."),
  },
  bs: connectionLost("Veza prekinuta", "Veza s terminalom je prekinuta. Ovo se može desiti kada se server restartuje."),
  da: connectionLost("Forbindelse mistet", "Terminalforbindelsen blev afbrudt. Dette kan ske, når serveren genstarter."),
  de: connectionLost(
    "Verbindung verloren",
    "Die Terminalverbindung wurde unterbrochen. Das kann passieren, wenn der Server neu startet.",
  ),
  es: connectionLost(
    "Conexión perdida",
    "La conexión del terminal se interrumpió. Esto puede ocurrir cuando el servidor se reinicia.",
  ),
  fr: connectionLost(
    "Connexion perdue",
    "La connexion au terminal a été interrompue. Cela peut arriver lorsque le serveur redémarre.",
  ),
  ja: {
    ...named("ターミナル"),
    ...connectionLost(
      "接続が失われました",
      "ターミナルの接続が中断されました。これはサーバーが再起動したときに発生することがあります。",
    ),
  },
  ko: {
    ...named("터미널"),
    ...connectionLost("연결 끊김", "터미널 연결이 중단되었습니다. 서버가 재시작하면 이런 일이 발생할 수 있습니다."),
  },
  no: connectionLost("Tilkobling mistet", "Terminalforbindelsen ble avbrutt. Dette kan skje når serveren starter på nytt."),
  pl: connectionLost(
    "Utracono połączenie",
    "Połączenie z terminalem zostało przerwane. Może się to zdarzyć przy restarcie serwera.",
  ),
  br: connectionLost(
    "Conexão Perdida",
    "A conexão do terminal foi interrompida. Isso pode acontecer quando o servidor reinicia.",
  ),
  ru: {
    ...named("Терминал"),
    ...connectionLost("Соединение потеряно", "Соединение с терминалом прервано. Это может произойти при перезапуске сервера."),
  },
  th: {
    ...named("เทอร์มินัล"),
    ...connectionLost("การเชื่อมต่อขาดหาย", "การเชื่อมต่อเทอร์มินัลถูกขัดจังหวะ อาจเกิดขึ้นเมื่อเซิร์ฟเวอร์รีสตาร์ท"),
  },
  tr: connectionLost("Bağlantı Kesildi", "Terminal bağlantısı kesildi. Bu durum sunucu yeniden başladığında oluşabilir."),
  zh: { ...named("终端"), ...connectionLost("连接已丢失", "终端连接已中断。这可能发生在服务器重启时。") },
  zht: { ...named("終端機"), ...connectionLost("連線中斷", "終端機連線已中斷。這可能會在伺服器重新啟動時發生。") },
} satisfies Translations<TerminalKey>

