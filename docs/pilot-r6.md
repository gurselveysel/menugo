# Bahçeşehir r6 pilotu

1. Yönetici girişi → Menü & Fiyatlar: tutarları düzenle, tükendi durumunu yönet.
2. Masalar & Sepet: masa oluştur / aç; 10 dakikalık QR katılım bağlantısını göster.
3. Sepeti aç: onaylı seçenek gerektirmeyen ürünleri siparişe gönder.
4. Mutfak: Kabul et → Hazırlanıyor → Hazır → Servis edildi.
5. Ödemeler → Kasa: gerçekten kasada alınmış tutarı ve yöntemi doğrulayarak kapat.
6. Online ödeme girişimi olan adisyonu bu yöntemle yeniden tahsil etme.
7. Ayarlar: masada yeni siparişleri durdur / aç.

Kasada kayıt, işletme çalışanının beyanıdır; PSP tahsilatı ve mali fiş/fatura değildir.
PSP/kurye/SMS/sadakat harcama bağlantıları açılmadı. 6 seçenekli ürün, varyant seçimi bağlanana kadar siparişe kapalı kalır.
Kimlik doğrulama için kayıt/giriş sürüyor; anonim masa misafiri modu Auth ayarıyla ayrıca açılmalıdır.
Supabase Auth URL Configuration: Site URL https://www.menugo.app ; Redirect URLs https://www.menugo.app/auth/callback ve https://sariyerborekcisi.menugo.app/auth/callback. Araç bu yönetim ayarını değiştirmedi.
Public GitHub deposuna sır veya müşteri verisi eklenmedi; ticari kod için private önerilir.
