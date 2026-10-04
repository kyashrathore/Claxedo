import type { ErrorMessages } from "./model"

export default {
  auth: ["请重新登录", "登录已过期或被拒绝。请重新登录后继续。"],
  rate_limit: ["请求过多", "服务器正在限制请求。请稍候再试。"],
  network: ["无法连接服务器", "无法连接到服务器。请检查网络连接后重试。"],
  not_found: ["未找到", "该内容已不存在，可能已被删除。"],
  conflict: ["已在别处更改", "该内容已先在别处被更改。请重新加载后再试。"],
  invalid: ["请求被拒绝", "服务器认为此请求无效并拒绝了它。"],
  internal: ["出错了", "发生了意外错误。请重试。"],
  signIn: "登录",
  retry: "重试",
  reload: "重新加载",
} satisfies ErrorMessages
