# AI Menü Stüdyosu — r15

İşletme sahibi/yönetici: `/isletme` → `AI Menü Stüdyosu`.
Bu artım yalnızca menü belgesini taslağa dönüştürme, eşleştirme, inceleme,
seçili değişiklikleri uygulama ve güvenli geri almayı içerir. Ürün görseli
üretimi, sosyal medya kampanyası veya fatura maliyeti modülü değildir.

## Kullanım

1. Menü fotoğrafını çekin veya JPG/PNG/WebP/PDF seçin. Tek dosya 2 MB,
   PDF en fazla 8 sayfa, bir taslak en fazla 100 ürün.
2. Vercel AI Gateway bağlantısı yalnızca belgedeki okunabilir bilgiden taslak
   çıkarır. Desteklenen model: `google/gemini-2.5-flash` (görsel/PDF).
3. Bütün satırlar başlangıçta **Atla** konumundadır. Tam ve tek anlamlı isim
   eşleşmeleri önerilir, otomatik uygulanmaz. Kategoriyi, porsiyonu, aynı fiyatlı
   seçenekleri ve fiyatı kontrol edin; güncellenecek ürünü veya yeni kaydı seçin.
4. Taslağı kaydetmek katalog yazmaz. Açık kontrol beyanıyla seçilenleri uygulayın.
5. Sonradan değişen ürün varsa toplu yazma/geri alma durur. Yeni ürünün geri
   alınması kaydı silmez, satışa kapatır. Ödenmiş sipariş snapshot'ları değişmez.

## Bağlantı / güvenlik

`AI_GATEWAY_API_KEY` sunucuda varsa kullanılır. Yoksa `@vercel/oidc` ile geçerli
Vercel proje token'ı çözülür. Kullanıcı anahtarları istemciye veya depoya yazılmaz.
Token bulunması, hesap kredisi ve model yetkisinin doğrulandığı anlamına gelmez.
401/403, kredi/402, kota/429, eksik yanıt ve ağ kesintisi ayrı hatalardır. Sahte
AI sonucu veya otomatik ücretli yeniden deneme yoktur. Model toplam kullanım
ücreti sağlayıcı koşullarına tabidir; uygulama abonelik/kredi satın almaz.

Günlük şube kotası 5 analiz denemesi (İstanbul günü); belge başına en fazla 3
çalıştırma. Başarısız/belirsiz denemeler kotaya dahildir. Her dosya hash'le
tekilleştirilir. Kaynak dosyaya erişim 30 gün sonra kapanır; sonraki günlük temizlikte silinir.
Yönetici önceden de silebilir.
En çok 20 kaynak dosya saklanır. Kaynak özel `ops` kaydındadır, herkese açık
Storage bucket/URL yoktur. Fotoğrafı AI sağlayıcısına iletme açıklaması yükleme
alanında gösterilir. Ürün kaynakları dışında kişisel veri yüklenmemelidir.

API gövde + dosya imzası/piksel/PDF sayfa kontrolü, SSR Auth, owner/manager rolü,
Origin kontrolü ve no-store uygulanır. SQL tek RPC transaction'ında katalog
satırları `FOR UPDATE` ile kilitlenir; kaynak sürüm ve taslak revizyonu karşılaştırılır.
Yeni parasal alanlar bigint; legacy public TL numeric sınırına yalnız canonical
kuruş metninden tam dönüşüm yapılır. Public şema DDL değiştirilmez.

## İş yürütme

Kaynak kaydı ve çalıştırma lease'i önce commit edilir, HTTP 202 sonrasındaki
Next `after()` işi tek sınırlı model çağrısı yapar. 45 saniye model çağrısı,
90 saniye lease; geç worker cevabı fenced edilir. Sunucu durursa `processing`
sonsuz kalmaz, snapshot `unknown` gösterir. Bu sürüm bağımsız sürekli worker
kurmaz; belirsiz bir iş için yeniden çalışma yöneticinin açık seçimidir.
Kişisel adisyon/ödeme yolunda AI çağrısı veya model beklemesi yoktur.

## Kabul testlerinin sınırı

Birim/SQL/arayüz testleri gerçek AI sağlayıcısını çağırmaz; üretilmiş menü
fixture'ları ve kontrollü transport kullanır. Gerçek model çıkarımı ve telefon
fotoğraf kalitesi ayrıca doğrulanmalıdır. Migration prod katalog satırı
oluşturmaz/değiştirmez; test fixture'ları prod'a yüklenmez.

Resmî sözleşmeler:
- https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc
- https://vercel.com/docs/ai-gateway/inputs-and-tools/file-input
- https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/structured-outputs
- https://ai-gateway.vercel.sh/v1/models
