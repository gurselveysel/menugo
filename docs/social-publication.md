# MenüGO sosyal yayın yetkilendirme dilimi (r34)

Bu dilim, kampanya görseli üretimi ile dış sosyal hesaba gönderim arasına açık bir yetkilendirme sınırı koyar.

## Yetki modeli

- İşletme sahibi/yöneticisi yalnız kendi şubesindeki onaylı ürün ve kampanya kanıtı için yayın isteği oluşturabilir veya henüz gönderilmemiş isteği iptal edebilir.
- `socialPublicationEnabled` şirket operasyon politikasıdır; restoran rolü bu anahtarı değiştiremez. Global kapatma şube tarafından aşılamaz.
- Sosyal sağlayıcı hesabı, erişim anahtarı ve teknik gönderim restoran arayüzünde bulunmaz. Bunlar yalnız MenüGO şirket kontrol alanına ait gelecekteki sağlayıcı adaptörünün sorumluluğudur.

## Güvenlik ve veri modeli

`ops.social_publication_intents` doğrudan RLS erişimine kapalıdır. Her istek ürün/fiyat/kampanya sürüm kanıtını yeniden doğrular, kapsam kilidi alır ve kullanıcı+operationId ile idempotenttir. İstek paketi doğrulanmış kampanya snapshot'ını saklar; API anahtarı, ziyaret token'ı veya ödeme bilgisi içermez.

Yeni istekler varsayılan olarak `awaiting_platform_connection` durumundadır. Bu sürümde dış sağlayıcı çağrısı YOKTUR. `dispatchConfigured:false` bilerek döndürülür; bağlantı yokken başarıyla sosyal paylaşım yapılmış izlenimi verilmez.

İptal işlemi merkezi yayın anahtarı kapatılsa bile çalışır. Böylece şirket acil durdurma uyguladığında bekleyen isteği güvenle geri çekmek mümkündür.

## Kabul sınırı

Bu dilim gerçek Instagram/Meta/Metricool yayını olarak sayılamaz. Tam kabul için şirket tarafından atanmış sosyal sağlayıcı bağlantısı, sağlayıcı tarafında yetkili hesap doğrulaması, gerçek ama yayımlanmayan dry-run/validation varsa onun sonucu ve en az bir kontrollü dış gönderim kabulü gerekir. Kullanıcı adına sosyal paylaşım bu geliştirme testlerinin parçası değildir.
