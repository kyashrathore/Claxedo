import type { ErrorMessages } from "./model"

export default {
  auth: ["請重新登入", "登入已過期或遭拒。請重新登入後繼續。"],
  forbidden: ["無權存取", "你的帳戶無權存取此內容。請向其擁有者申請存取權限。"],
  rate_limit: ["請求過多", "伺服器正在限制請求。請稍候再試。"],
  network: ["無法連線至伺服器", "無法連線至伺服器。請檢查網路連線後重試。"],
  not_found: ["找不到", "此內容已不存在，可能已被刪除。"],
  conflict: ["已在他處變更", "此內容已先在他處被變更。請重新載入後再試。"],
  invalid: ["請求遭拒", "伺服器認為此請求無效並拒絕了它。"],
  internal: ["發生錯誤", "發生未預期的錯誤。請重試。"],
  signIn: "登入",
  retry: "重試",
  reload: "重新載入",
} satisfies ErrorMessages
