import type { ErrorMessages } from "./model"

export default {
  auth: ["Yeniden oturum açın", "Oturumunuzun süresi doldu veya reddedildi. Devam etmek için yeniden oturum açın."],
  forbidden: ["İzin verilmiyor", "Hesabınızın buna erişimi yok. Sahibinden erişim isteyin."],
  rate_limit: ["Çok fazla istek", "Sunucu istekleri sınırlıyor. Biraz bekleyip yeniden deneyin."],
  network: ["Sunucuya ulaşılamıyor", "Sunucuya ulaşılamadı. Bağlantıyı kontrol edip yeniden deneyin."],
  not_found: ["Bulunamadı", "Bu artık mevcut değil. Silinmiş olabilir."],
  conflict: ["Başka bir yerde değiştirildi", "Bu önce başka bir yerde değiştirildi. Yeniden yükleyip tekrar deneyin."],
  invalid: ["İstek reddedildi", "Sunucu bu isteği geçersiz olduğu için reddetti."],
  internal: ["Bir şeyler ters gitti", "Beklenmeyen bir hata oluştu. Yeniden deneyin."],
  signIn: "Oturum aç",
  retry: "Yeniden dene",
  reload: "Yeniden yükle",
} satisfies ErrorMessages
