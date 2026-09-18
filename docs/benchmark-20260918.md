# MenüGO — Ürün kıyaslaması ve uygulama kararları

İnceleme tarihi: 18 Eylül 2026. Kaynaklar markaların resmî ürün ve yardım sayfalarıdır. Bu kapsam dünyanın/Türkiye'nin bütün markalarını tüketmez; 24 referans sağlayıcıyı kapsar. Ücretli panel, gerçek tahsilat veya kurye sözleşmesi test edilmemiştir. “Yakında” özellikleri canlı ürün kabul edilmemiştir. Satış artışı iddiaları MenüGO sonucu sayılmaz. Tasarım ve marka varlıkları kopyalanmamıştır.

## Türkiye — 8 referans

| Marka | Resmî kaynak | Çıkarılan değer / sınır |
|---|---|---|
| Simpra | https://simprasuite.com.tr/restoran-otomasyonu/qr-menu/ | Üyelik ve şifre istemeyen menü/sipariş; personel kabulünden sonra mutfak/bar. Mevcut kodsuz MenüGO akışı korunur. |
| Adisyo | https://adisyo.com/qr-kod-karekod-dijital-menu-tablet-menu-programi | Masaya özel QR ile adisyon/operasyonun bağlanması. Menü ayrı, kopuk bir vitrin olmamalı. |
| Menulux | https://www.menulux.com/restoran-otomasyonu/dijital-menu/karekod-qr-menu | Ürün görseli, etiket/alerjen bilgisi, garson çağrısı ve geri bildirim. Bilinmeyen alerjen tahmin edilmez. |
| FineDine | https://www.finedinemenu.com/tr/solutions/qr-kod-siparis-ve-odeme/ | Marka deneyimi, dijital ürün bilgisi, dil ve çok kanallı sipariş. Sağlayıcı bağlılığı ayrıca doğrulanır. |
| Tabpad | https://www.tabpadmenu.com/ | Menü–adisyon–maliyet/arka ofis bütünlüğü; “yakında” modüller tamamlanmış sayılmadı. |
| Pardon AI | https://www.pardon-ai.com/ | Mevcut temas noktalarından analiz/öneri. Pazarlanan performans yüzdeleri bize taşınmadı. |
| robotPOS | https://www.robotpos.com/ | POS ve operasyon entegrasyonu; aynı siparişin yeniden elle girilmesini önleme. |
| NarPOS | https://narpos.com.tr/ | Garson/kurye/rapor/menü etrafında işletme merkezi. MenüGO'da doğrulanmamış kurye servisi açılmadı. |

## Global — 16 referans

| Marka | Resmî kaynak | Çıkarılan değer / sınır |
|---|---|---|
| Toast | https://support.toasttab.com/en/article/Guest-Experience-for-Toast-Mobile-Order-Pay | Garson ve telefondan siparişin aynı adisyonda birleşmesi; solo/grup ayrımı. Her akışın hesap/telefon koşulu aynı değil. |
| Square | https://squareup.com/us/en/point-of-sale/restaurants/kitchen-display-system | Mutfak bileti, bekleme zamanı ve istasyon odaklı çalışma. |
| Sunday | https://sundayapp.com/digital-bill/ | Dijital hesap ve bölüşüm, ödeme sonrası geri bildirim. PSP bağlantısı olmadan gerçek ödeme vaadi verilmedi. |
| me&u | https://www.meandu.com/ | Sipariş deneyimi ve kişiselleştirme. İlk sürüm öneri motorumuz deterministik kalır. |
| Lightspeed | https://www.lightspeedhq.com/pos/restaurant/order-anywhere/ | Hazırlık süresi, uygunluk ve operasyonla bağlı sipariş. |
| Flipdish | https://help.flipdish.com/en/articles/9585395-manage-order-capacity | Yoğunluk/kapasite yönetimi. Yeni süreli mola, bu fikrin masa siparişi uyarlamasıdır; teslimat zaman dilimi rezervasyonu değildir. |
| Deliverect | https://www.deliverect.com/en-us/dispatch | Tek operasyon merkezinde kendi ve dış kurye. Gerçek adaptör/sözleşme gerektirir. |
| GloriaFood | https://www.gloriafood.com/ | Doğrudan sipariş ve restoranın kendi müşteri temasları. |
| TouchBistro | https://www.touchbistro.com/kitchen-display-system/ | Sesli yeni sipariş uyarısı, bilet yaşı ve okunabilir mutfak ekranı. |
| Oracle Simphony | https://www.oracle.com/food-beverage/restaurant-pos-systems/ | Kurumsal POS, operasyon ve ekosistem bütünlüğü. |
| Clover | https://www.clover.com/pos-solutions/restaurant | Restoran siparişi, ödeme ve arka ofis. Özel donanım/PSP bağımlılıkları vardır. |
| Foodics | https://www.foodics.com/ | POS, mutfak, garson, raporlama ve entegrasyon katmanları. |
| Olo | https://www.olo.com/ | Doğrudan sipariş, teslimat, ödeme ve müşteri ilişkisini ayrı fakat bağlantılı modüllerle yönetme. |
| Restroworks | https://www.restroworks.com/ | Merkezi menü/POS ve operasyon raporlaması. |
| qlub | https://qlub.io/ae/en | Dijital menü/temassız ödeme deneyimi; ödeme kuruluşu bağlantısı ayrıca gereklidir. |
| Loyverse | https://loyverse.com/kitchen-display-system | Yaşa göre bilet işaretleri, sesli uyarı ve okunur mutfak bileti. |

## r13 için seçilen ve gerçek uygulamaya eklenen kapsam

1. **Menü keşfi:** Fiyata veya ada göre sıralama, satışa uygun ürün filtresi, yalnız yayımlanmış içerik bilgisi olan ürün filtresi. Filtre alerjen güvenliği garantisi değildir. Bilinmeyen fiyat en sonda; para BigInt karşılaştırmasıyla sıralanır.
2. **Paylaşılabilir ürün:** Tek ürünün menüde açıldığı kalıcı bağlantı. Masa/ziyaret sırrı paylaşılmaz. Aynı ürün için fiyat her seferinde sunucudan gelir.
3. **Yazdırılabilir güncel menü:** Tarayıcı yazdırması için ayrı erişilebilir metin menüsü; yeni fiyat kaynağı veya donanım bağlantısı oluşturmaz.
4. **KDS iyileştirmesi:** Durum/masa filtresi, yaş ve gecikme işareti, büyük yazı, tam ekran ve isteğe bağlı ses/ekran açık tutma. İşletim sistemi/brauzer izinlerine bağlıdır; arka plan push veya POS yazıcı entegrasyonu değildir.
5. **15/30/60 dakikalık yoğunluk molası:** Yönetici yetkisi ve sürüm kontrolü; her yeni siparişin DB transaction'ında uygulanır, sepet hata halinde korunur. Süre dolunca kısıt sona erer; genel sipariş kapatma ayarı değişmez. Mevcut siparişlerin kabul/hazırlama/teslimi durdurulmaz.
6. **Özel ziyaret geri bildirimi:** Üyelik olmadan yalnız kendi servis edilmiş siparişine bağlı bir görüş. Aynı ziyaret tekrar puan vermez; düşük/yüksek tüm puanlar aynı biçimde işlenir. Yönetici yorumu değiştiremez; yalnız incelendi işaretler. Pazarlama izni, Google değerlendirmesi veya herkese açık yıldız puanı değildir.
7. **Günlük operasyon raporu:** Europe/Istanbul gün sınırı. Sipariş değeri ve kasaya kaydedilen nakit/harici POS ayrı. Kaynak adisyon/intents tahsilatmış gibi sayılmaz. CSV formül enjeksiyonu önlenir. Mali belge, vergi raporu, kâr veya banka mutabakatı değildir.

## Korunanlar / açılmayanlar

Kodsuz müşteri siparişi, özel misafir verisi, personel kabulü, kuruş hassasiyeti, idempotency, masa QR'si, WhatsApp talebi, saydam logolar ve beyaz MenüGO alt bölümü korunur. Mevcut fiyatlar ve ürünler değiştirilmez.

Online kart tahsilatı, otomatik DaaS, puan harcama, ticari SMS, POS/yazıcı/donanım ve rezervasyon/teslimat-slot ürünleri bu sürümde açılmaz. Bunlar sağlayıcı erişimi, işletme politikası, veri veya ayrı güvenlik/kabul testi gerektirir. Müşteri adresi, saati, içerik/alerjen bilgisi uydurulmaz.

## Doğrulama notu

Bu dosya ürün kapsamını belirtir, testlerin başarıyla çalıştığına dair kendi başına kanıt değildir. Sonuçlar GitHub Actions kabul raporunda, üretim sürümü public/release.json içinde tutulur. Canlı testler okuma amaçlıdır; geçerli masa-katılım sayfasını açmak otomatik gerçek ziyaret oluşturduğu için bu sayfalar izole test ortamında doğrulanır.
