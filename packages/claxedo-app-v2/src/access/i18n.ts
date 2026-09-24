import type { Translations } from "@/i18n"

export type Keys =
  | "access.share.open"
  | "access.share.title"
  | "access.share.intro"
  | "access.share.level.follow"
  | "access.share.level.send"
  | "access.share.level"
  | "access.share.identifier"
  | "access.share.add"
  | "access.share.added"
  | "access.share.org"
  | "access.share.limit"
  | "access.share.allow"
  | "access.share.revoke"
  | "access.share.revokeFor"
  | "access.share.empty"
  | "access.share.participant"
  | "access.share.user"
  | "access.share.disclosure.title"
  | "access.share.disclosure.body"
  | "access.share.disclosure.acknowledge"
  | "access.share.disclosure.confirm"
  | "access.share.cancel"
  | "access.share.retry"
  | "access.share.failed"
  | "access.org.title"
  | "access.org.description"
  | "access.org.role.owner"
  | "access.org.role.admin"
  | "access.org.role.member"
  | "access.org.you"
  | "access.org.accounts"
  | "access.org.accounts.hint"
  | "access.org.restricted"
  | "access.org.signedOut"
  | "access.org.none"

export const dictionary = {
  en: {
    "access.share.open": "Share",
    "access.share.title": "Share this session",
    "access.share.intro": "A session share is the only thing that lets a teammate reach this session.",
    "access.share.level.follow": "Can follow",
    "access.share.level.send": "Can send messages",
    "access.share.level": "Share level",
    "access.share.identifier": "Person identifier",
    "access.share.add": "Add person",
    "access.share.added": "Person added to session",
    "access.share.org": "Everyone in the organization",
    "access.share.limit": "Limit to following",
    "access.share.allow": "Let them send",
    "access.share.revoke": "Revoke",
    "access.share.revokeFor": "Revoke {{name}}",
    "access.share.empty": "No one has been added yet.",
    "access.share.participant": "Participant {{name}}",
    "access.share.user": "User {{id}}",
    "access.share.disclosure.title": "Before you allow sending",
    "access.share.disclosure.body": "The agent runs on the workspace's machine with that machine's files. A teammate who can send messages can ask it to read anything there, including the transcripts of your other sessions in this workspace. Sharing works best for sessions on a cloud environment, where each session has a machine of its own. If this machine holds anything you would not want a teammate to reach, do not share sessions from workspaces on it.",
    "access.share.disclosure.acknowledge": "I understand what a teammate who can send messages can reach.",
    "access.share.disclosure.confirm": "Allow sending",
    "access.share.cancel": "Cancel",
    "access.share.retry": "Retry",
    "access.share.failed": "Could not change sharing",
    "access.org.title": "Organization",
    "access.org.description": "The people you work with. An organization grants nothing on any machine, folder or project.",
    "access.org.role.owner": "Owner",
    "access.org.role.admin": "Admin",
    "access.org.role.member": "Member",
    "access.org.you": "You",
    "access.org.accounts": "Organization accounts",
    "access.org.accounts.hint": "Provider accounts every member's agents may run on are managed under Accounts by an owner or admin.",
    "access.org.restricted": "Only owners and admins can manage the organization.",
    "access.org.signedOut": "Sign in to see your organization.",
    "access.org.none": "You are not in an organization.",
  },
  ar: {
    "access.share.level.follow": "يمكنه المتابعة",
    "access.share.level.send": "يمكنه إرسال الرسائل",
    "access.share.disclosure.body": "يعمل الوكيل على جهاز مساحة العمل باستخدام ملفات ذلك الجهاز. يمكن لزميل الفريق الذي يستطيع إرسال الرسائل أن يطلب منه قراءة أي شيء هناك، بما في ذلك نصوص جلساتك الأخرى في مساحة العمل هذه. تعمل المشاركة على أفضل وجه مع الجلسات في بيئة سحابية، حيث تملك كل جلسة جهازًا خاصًا بها. إذا كان هذا الجهاز يحتوي على أي شيء لا تريد أن يصل إليه زميل في الفريق، فلا تشارك الجلسات من مساحات العمل الموجودة عليه.",
    "access.share.cancel": "إلغاء",
    "access.org.title": "المؤسسة",
  },
  br: {
    "access.share.level.follow": "Pode acompanhar",
    "access.share.level.send": "Pode enviar mensagens",
    "access.share.disclosure.body": "O agente é executado na máquina do espaço de trabalho, com os arquivos dessa máquina. Um colega de equipe que pode enviar mensagens pode pedir a ele que leia qualquer coisa ali, incluindo as transcrições das suas outras sessões neste espaço de trabalho. O compartilhamento funciona melhor para sessões em um ambiente na nuvem, onde cada sessão tem uma máquina própria. Se esta máquina contiver algo que você não gostaria que um colega de equipe alcançasse, não compartilhe sessões de espaços de trabalho que estão nela.",
    "access.share.cancel": "Cancelar",
    "access.org.title": "Organização",
  },
  bs: {
    "access.share.level.follow": "Može pratiti",
    "access.share.level.send": "Može slati poruke",
    "access.share.disclosure.body": "Agent radi na uređaju radnog prostora s datotekama tog uređaja. Član tima koji može slati poruke može ga zamoliti da pročita bilo šta na njemu, uključujući transkripte vaših drugih sesija u ovom radnom prostoru. Dijeljenje najbolje funkcionira za sesije u cloud okruženju, gdje svaka sesija ima vlastiti uređaj. Ako se na ovom uređaju nalazi bilo šta što ne biste željeli da član tima dosegne, nemojte dijeliti sesije iz radnih prostora na njemu.",
    "access.share.cancel": "Otkaži",
    "access.org.title": "Organizacija",
  },
  da: {
    "access.share.level.follow": "Kan følge med",
    "access.share.level.send": "Kan sende beskeder",
    "access.share.disclosure.body": "Agenten kører på arbejdsområdets maskine med den maskines filer. En kollega, der kan sende beskeder, kan bede den om at læse hvad som helst dér, herunder udskrifterne af dine andre sessioner i dette arbejdsområde. Deling fungerer bedst for sessioner i et cloudmiljø, hvor hver session har sin egen maskine. Hvis denne maskine indeholder noget, du ikke ønsker, at en kollega skal kunne nå, så del ikke sessioner fra arbejdsområder på den.",
    "access.share.cancel": "Annuller",
    "access.org.title": "Organisation",
  },
  de: {
    "access.share.level.follow": "Kann mitlesen",
    "access.share.level.send": "Kann Nachrichten senden",
    "access.share.disclosure.body": "Der Agent läuft auf dem Gerät des Arbeitsbereichs und arbeitet mit den Dateien dieses Geräts. Ein Teammitglied, das Nachrichten senden kann, kann ihn bitten, dort alles zu lesen – einschließlich der Transkripte Ihrer anderen Sitzungen in diesem Arbeitsbereich. Das Teilen eignet sich am besten für Sitzungen in einer Cloud-Umgebung, in der jede Sitzung ein eigenes Gerät hat. Wenn sich auf diesem Gerät etwas befindet, das ein Teammitglied nicht erreichen soll, teilen Sie keine Sitzungen aus Arbeitsbereichen auf diesem Gerät.",
    "access.share.cancel": "Abbrechen",
    "access.org.title": "Organisation",
  },
  es: {
    "access.share.level.follow": "Puede seguir",
    "access.share.level.send": "Puede enviar mensajes",
    "access.share.disclosure.body": "El agente se ejecuta en el equipo del espacio de trabajo con los archivos de ese equipo. Un compañero de equipo que pueda enviar mensajes puede pedirle que lea cualquier cosa que haya allí, incluidas las transcripciones de tus otras sesiones en este espacio de trabajo. Compartir funciona mejor con sesiones en un entorno en la nube, donde cada sesión tiene un equipo propio. Si este equipo contiene algo a lo que no querrías que llegara un compañero de equipo, no compartas sesiones de los espacios de trabajo que están en él.",
    "access.share.cancel": "Cancelar",
    "access.org.title": "Organización",
  },
  fr: {
    "access.share.level.follow": "Peut suivre",
    "access.share.level.send": "Peut envoyer des messages",
    "access.share.disclosure.body": "L'agent s'exécute sur la machine de l'espace de travail, avec les fichiers de cette machine. Un coéquipier qui peut envoyer des messages peut lui demander de lire n'importe quoi sur celle-ci, y compris les transcriptions de vos autres sessions dans cet espace de travail. Le partage convient surtout aux sessions dans un environnement cloud, où chaque session dispose de sa propre machine. Si cette machine contient quoi que ce soit que vous ne voudriez pas qu'un coéquipier puisse atteindre, ne partagez pas de sessions issues des espaces de travail qui s'y trouvent.",
    "access.share.cancel": "Annuler",
    "access.org.title": "Organisation",
  },
  ja: {
    "access.share.level.follow": "フォロー可能",
    "access.share.level.send": "メッセージ送信可能",
    "access.share.disclosure.body": "エージェントはワークスペースのマシン上で、そのマシンのファイルを使って動作します。メッセージを送信できるチームメンバーは、このワークスペースにある他のセッションのトランスクリプトを含め、そのマシン上のあらゆるものを読むようエージェントに依頼できます。共有は、セッションごとに専用のマシンが用意されるクラウド環境上のセッションに最も適しています。このマシンにチームメンバーに見られたくないものがある場合は、このマシン上のワークスペースからセッションを共有しないでください。",
    "access.share.cancel": "キャンセル",
    "access.org.title": "組織",
  },
  ko: {
    "access.share.level.follow": "팔로우 가능",
    "access.share.level.send": "메시지 전송 가능",
    "access.share.disclosure.body": "에이전트는 작업 공간이 있는 컴퓨터에서 그 컴퓨터의 파일을 사용해 실행됩니다. 메시지를 보낼 수 있는 팀원은 이 작업 공간에 있는 다른 세션의 대화 기록을 포함해 그 컴퓨터에 있는 모든 것을 읽어 달라고 에이전트에게 요청할 수 있습니다. 공유는 세션마다 별도의 컴퓨터가 제공되는 클라우드 환경의 세션에 가장 적합합니다. 이 컴퓨터에 팀원이 접근하지 않았으면 하는 것이 있다면 이 컴퓨터의 작업 공간에서 세션을 공유하지 마세요.",
    "access.share.cancel": "취소",
    "access.org.title": "조직",
  },
  no: {
    "access.share.level.follow": "Kan følge med",
    "access.share.level.send": "Kan sende meldinger",
    "access.share.disclosure.body": "Agenten kjører på arbeidsområdets maskin med filene på den maskinen. En kollega som kan sende meldinger, kan be den om å lese hva som helst der, inkludert utskriftene av de andre sesjonene dine i dette arbeidsområdet. Deling fungerer best for sesjoner i et skymiljø, der hver sesjon har sin egen maskin. Hvis denne maskinen inneholder noe du ikke vil at en kollega skal få tilgang til, bør du ikke dele sesjoner fra arbeidsområder på den.",
    "access.share.cancel": "Avbryt",
    "access.org.title": "Organisasjon",
  },
  pl: {
    "access.share.level.follow": "Może obserwować",
    "access.share.level.send": "Może wysyłać wiadomości",
    "access.share.disclosure.body": "Agent działa na komputerze przestrzeni roboczej i korzysta z plików tego komputera. Członek zespołu, który może wysyłać wiadomości, może poprosić go o odczytanie wszystkiego, co się tam znajduje, w tym transkrypcji Twoich pozostałych sesji w tej przestrzeni roboczej. Udostępnianie sprawdza się najlepiej w przypadku sesji w środowisku chmurowym, gdzie każda sesja ma własny komputer. Jeśli na tym komputerze znajduje się cokolwiek, do czego członek zespołu nie powinien mieć dostępu, nie udostępniaj sesji z przestrzeni roboczych na tym komputerze.",
    "access.share.cancel": "Anuluj",
    "access.org.title": "Organizacja",
  },
  ru: {
    "access.share.level.follow": "Может наблюдать",
    "access.share.level.send": "Может отправлять сообщения",
    "access.share.disclosure.body": "Агент работает на компьютере рабочего пространства и использует файлы этого компьютера. Участник команды, который может отправлять сообщения, может попросить агента прочитать там что угодно, включая стенограммы других ваших сессий в этом рабочем пространстве. Общий доступ лучше всего подходит для сессий в облачной среде, где у каждой сессии есть собственный компьютер. Если на этом компьютере есть что-то, к чему участник команды не должен получить доступ, не делитесь сессиями из рабочих пространств на нём.",
    "access.share.cancel": "Отмена",
    "access.org.title": "Организация",
  },
  th: {
    "access.share.level.follow": "ติดตามได้",
    "access.share.level.send": "ส่งข้อความได้",
    "access.share.disclosure.body": "เอเจนต์ทำงานบนเครื่องของพื้นที่ทำงานโดยใช้ไฟล์ของเครื่องนั้น เพื่อนร่วมทีมที่ส่งข้อความได้สามารถขอให้เอเจนต์อ่านสิ่งใดก็ได้บนเครื่องนั้น รวมถึงบันทึกการสนทนาของเซสชันอื่น ๆ ของคุณในพื้นที่ทำงานนี้ การแชร์เหมาะที่สุดกับเซสชันในสภาพแวดล้อมคลาวด์ ซึ่งแต่ละเซสชันมีเครื่องเป็นของตัวเอง หากเครื่องนี้มีสิ่งใดที่คุณไม่ต้องการให้เพื่อนร่วมทีมเข้าถึงได้ อย่าแชร์เซสชันจากพื้นที่ทำงานบนเครื่องนี้",
    "access.share.cancel": "ยกเลิก",
    "access.org.title": "องค์กร",
  },
  tr: {
    "access.share.level.follow": "Takip edebilir",
    "access.share.level.send": "Mesaj gönderebilir",
    "access.share.disclosure.body": "Ajan, çalışma alanının bulunduğu makinede o makinenin dosyalarıyla çalışır. Mesaj gönderebilen bir ekip arkadaşı, bu çalışma alanındaki diğer oturumlarınızın dökümleri dahil oradaki her şeyi okumasını ajandan isteyebilir. Paylaşım, her oturumun kendi makinesine sahip olduğu bulut ortamındaki oturumlar için en iyi sonucu verir. Bu makinede bir ekip arkadaşının erişmesini istemeyeceğiniz herhangi bir şey varsa, bu makinedeki çalışma alanlarından oturum paylaşmayın.",
    "access.share.cancel": "İptal",
    "access.org.title": "Kuruluş",
  },
  zh: {
    "access.share.level.follow": "可以关注",
    "access.share.level.send": "可以发送消息",
    "access.share.disclosure.body": "智能体在工作区所在的机器上运行，并使用该机器上的文件。可以发送消息的团队成员可以让它读取该机器上的任何内容，包括你在此工作区中其他会话的记录。共享最适合云环境中的会话，那里每个会话都拥有自己的机器。如果这台机器上有任何你不希望团队成员接触到的内容，请不要共享这台机器上工作区中的会话。",
    "access.share.cancel": "取消",
    "access.org.title": "组织",
  },
  zht: {
    "access.share.level.follow": "可以關注",
    "access.share.level.send": "可以傳送訊息",
    "access.share.disclosure.body": "代理在工作區所在的機器上執行，並使用該機器上的檔案。可以傳送訊息的團隊成員可以請它讀取該機器上的任何內容，包括你在此工作區中其他工作階段的逐字稿。共用最適合雲端環境中的工作階段，在那裡每個工作階段都有自己的機器。如果這台機器上有任何你不希望團隊成員存取的內容，請不要共用這台機器上工作區中的工作階段。",
    "access.share.cancel": "取消",
    "access.org.title": "組織",
  },
} satisfies Translations<Keys>
