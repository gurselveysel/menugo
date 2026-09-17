# CRM / 21 gün değerlendirme

1. Ödeme payı gerçekten tahsil edilmiş, gıda siparişi tamamlanmış olmalı.
2. Satın alma kanıtının sahibi ile müşteri eşleşmeli; bahşiş ve teslimat gıda geliri değildir.
3. Son uygun sipariş üzerinden varsayılan 21 gün geçmiş olmalı.
4. Doğrulanmış telefon, ayrı ve son yerel SMS izni, aynı işletme markasının taze İYS onayı aranır.
5. Kampanya/müşteri/son-sipariş üçlüsü tekilleştirilir.
6. Kuyruk, tekrar sipariş/ret/izin değişikliğinde gönderimden önce bastırılır.
7. Gerçek gönderim ancak canlı kampanya, açık SMS anahtarı, onaylı metin, gerçek sağlayıcı ve
   geçerli teklif + ret bağlantısı renderer'ı ile mümkündür. Bunlar bu yayında kapalıdır.
8. Yanıtı belirsiz gönderim tekrar denenmez; sağlayıcı referansıyla mutabakat gerekir.

Cron: `menugo-winback-evaluation` / `5 * * * *` / `select ops.crm_enqueue();`.
Bu gerçek zamanlayıcı yalnız DB değerlendirmesi yapar. İzin verme, fiyat güncelleme,
kupon taahhüdü, para tahsilatı veya SMS gönderme yetkisi vermez.

E-posta/SMS kampanya yayın ve müşteri izin kanıtı toplama sözleşmeleri üretimde açılmadan
önce işletmenin veri sorumluluğu, saklama süresi, ret akışı ve İYS entegrasyonu tamamlanmalıdır.
