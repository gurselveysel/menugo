# İncelenmiş ürün fotoğrafını menüye uygulama — r31 çalışma adayı

Durum: YEREL GELİŞTİRME / ÜRETİME ALINMADI. r30 main tabanı: 31179a957efb44e49368bd8a6e740bbf0e33a1f9.
Son gerçek alan adı okuması r29 döndürdü. Bu dosya yayın kanıtı değildir.

## İşletme akışı
1. Şirketin açtığı ücretsiz sağlayıcıyla gerçek fotoğraftan taslak üret.
2. Kaynak ve taslağı karşılaştır; mevcut stüdyoda incelenmiş olarak kaydet.
3. Fotoğraf yayımlama bölümünde taslağı seç; kaynak/taslak ve varsa mevcut menü fotoğrafını gör.
4. İki görsel yüklenmeden onay kutusu açılmaz. İşletme gerçek porsiyon/malzeme uygunluğunu doğrular.
5. Onaylı görsel ürün kartına, ayrıntı penceresine, editoryal ürün seçkisine ve masa siparişi ürün görseline bağlanır.
6. Yayın geçmişinden ayrı onayla geri alınabilir. Daha yeni bir yayın varsa geri alma reddedilir.

## Sınırlar
- Fiyat, ürün adı/içeriği, alerjen, porsiyon, sipariş ve tahsilat tabloları değiştirilmez.
- Tam otomatik yayın yok. İstemci yalnız jobId/revizyon/hash/işlem kimliği gönderir; URL veya piksel gönderemez.
- Apply/undo/idempotency kaydı tek transaction; önce tenant-yetki, şube yayın kilidi, job/product/overlay kilitleri.
- Yeni fotoğraf uygulaması şirket `studioPublicationEnabled` politikasıyla durdurulabilir. Undo ve eski makbuzun güvenli tekrarı çalışır.
- Sağlayıcı anahtarı, model seçimi ve teknik limitler yine yalnız şirket yönetimindedir. Yeni model çağrısı veya ücretli fallback eklenmedi.
- İşletme/şube/ürün ilişkileri denetlenir. Doğrudan müşteri/anon tablo okuması-yazması kapalıdır.
- Public görüntü route'u yalnız hâlen aktif ve kaynak hash'i geçerli yayımlanmış çıktıyı okur. Özel kaynak dosya veya taslak URL'leri müşteriye verilmez.
- Normalleştirilmiş WebP çıktısı yeni immutable varlığa kopyalanır; stüdyo işinin 7 günlük saklama/discard işlemi yayımlanan görseli silmez.
- Geçmiş fotoğraflar undo için tutulur. Otomatik temizleme yok; büyüme sonrası kontrollü arşivleme ve saklama politikası ayrıca tasarlanmalıdır.
- İlk sürüm bytea üst sınırı 4 MiB / çıktı 4 megapiksel. Sayfa dışı URL'ler, SVG, çoklu kare ve bozuk görsel engellenir.
- Bütün kaynak guard'ı muhafazakârdır: fiyat/uygunluk/ürün metadata değişimi de eski görseli müşteri kataloğunda gizleyebilir. Yeniden inceleme gerekir; sessiz eski kaynak kullanımı yok.
- Eski fotoğraf zaten müşterinin cihazına indiyse uzaktan silme garantisi verilmez. Yeni GET'lerde aktiflik yeniden denetlenir, no-store kullanılır.

## Çalıştırılan kabul
- 443 birim testi (33 yeni fotoğraf girdi/görsel çözümleme kontrolü dahil).
- PGlite üzerinde bütün migration'lar ve 381 SQL kontrolü (42 yeni fotoğraf yaşam döngüsü kontrolü dahil). SQL/constraints gerçek, Supabase Auth/Vault/Realtime test fixture'dır.
- Gerçek yeni React bileşenlerini ve yeni API route'larını içeren izole Next.js harness: derleme/strict TypeScript geçti.
- 25 gerçek tarayıcı etkileşim kontrolü: kıyaslama, boş onay, kayıp yanıt, sayfa yenilemesi sonrası aynı kimlikle tekrar, geri alma, eski kaynak, yüklenemeyen görsel, gerçek müşteri bileşeninde fotoğraf/fiyat, mobil yerleşim, yeni API oturumsuz 401.
- HTTP verileri ve örnek fotoğraflar sentetik; model çağrısı yok. 320/360/390/768/1440 ekran görüntüleri incelendi.

## Çalıştırılmayan zorunlu kabul
- Tam uygulama r30+r31 build: bu ortamda tam r30 PDF.js 6.3.289 paketi yok. Önceki r29 dependency artifact'i kullanıldı. İzole harness build'i tam uygulama build'i değildir.
- Gerçek PostgreSQL 17 / iki bağımsız DB bağlantısıyla fotoğraf concurrency: test dosyası eklendi, yerel PG sunucusu yok.
- Gerçek ücretsiz AI sağlayıcısıyla çıktı/insan incelemesi, fiziksel telefon ve üretim uçtan uca.

## Kota sonrası yayın sırası
1. 2026-09-20T23:12:57Z öncesinde deploy/Git push/merge yapılmaz. Bu tarih, önceki 24 saatlik Vercel retry penceresidir; garantili yayın saati değildir.
2. issue #1/main/PR'leri yeniden oku. Bu yerel delta'yı yalnız doğrulanmış tabana `git apply --check` ile incele; güncel değişiklikleri ezme.
3. Exact lockfile ile npm ci; 443 test + SQL fixture + native-postgres.integration + tam Next build + harness ve mevcut UI regresyonları.
4. Başarılı gerçek DB testlerinden sonra additive migration'ı Supabase'e uygula. Eski katalog fonksiyonu ve canlı müşteri verileri korunur.
5. Git-bağlı tek kontrollü yayın; vendor yeni retry sınırı verirse dur. Ücretli plan/alternatif hesap/proje açma.
6. Gerçek alan adı sürümü ve oturum yetki kontrolleri doğrulanmadan yayında deme. Tek tek gerçek AI/üretim kabulü bitmeden aiSuiteComplete=true yapma.
