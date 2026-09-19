# MenüGO — açık kaynak model geçişi

## Maliyet ve kapsam

Kullanıcı 19 Eylül 2026'da açık kaynak/ücretsiz model politikasını seçti. Model lisansının ücretsiz olması barındırma, elektrik, donanım, Vercel/Supabase işlem ve ağ maliyetlerini ortadan kaldırmaz. Bu değişiklik ücretli sunucu açmaz, GPU satın almaz ve hiçbir sağlayıcı kredisi satın almaz. Ücretli API'ye otomatik fallback YOK.

Qwen3.5-4B ve Qwen3.5-9B model kartları Apache-2.0 ve image-text-to-text olarak yayımlanmıştır. Mevcut uygulamada lisansı bu modellerle doğrulanmış bir allowlist vardır. Yeni model eklenmesi ayrı lisans ve kabul testi ister. Ollama id'leri `qwen3.5:4b`, `qwen3.5:9b`; vLLM id'leri `Qwen/Qwen3.5-4B`, `Qwen/Qwen3.5-9B`.

Desteklenen yeni protokol: test, salt okunur işletme asistanı, tek menü görüntüsünden taslak, ürün açıklaması, çeviri, kampanya metni, fatura görüntüsünden inceleme taslağı. Fiyat/alerjen/kalori/finans değerleri otomatik uygulanmaz. Mevcut onay, sürüm, uygulama/geri-alma sınırı korunur.

Doğrudan PDF girdisi bu endpoint'te desteklenmez: sayfalar kontrollü biçimde görüntüye dönüştürülmelidir. Bu sürüm otomatik PDF dönüştürücü kurmaz. Ürün fotoğrafı üretimi için ayrı görüntü modeli/worker gerekir; Qwen-Image-Edit (Apache-2.0) adaydır, fakat bu sürümde çalıştırılmadı/bağlanmadı. Metin LLM'sinin fotoğraf ürettiği iddia edilmez.

## Ağ ve yetki

Sabit hedef `https://ai.menugo.app/v1/chat/completions`. Kullanıcı tarafından gönderilen URL/host kullanılmaz. Bu alan adı uygulamaya ait bir entegrasyon hedefidir, şu an çalıştığı veya DNS'inin kurulduğu iddiası DEĞİLDİR. Vercel ve Supabase üzerinde büyük model ağırlıkları çalıştırılmaz.

Gerçek bilgisayar/sunucu belirlendikten sonra:
1. RAM/GPU, işletim sistemi, sürekli açık kalma ve ağ erişimi kontrol edilir. Yeni donanım alımına varsayılan olarak ihtiyaç olduğu söylenmez.
2. Ollama'nın doğrulanmış sürümü kurulur. `OLLAMA_NO_CLOUD=1` ile cloud ve web search kapatılır. İlk pilotta 4B, kalite/performans kabulü uygunsa 9B seçilir. Sürüm/model digest'i kabul kaydına yazılır.
3. Ollama admin portu 11434 internetten açılmaz. Yalnız HTTPS ters proxy ve POST `/v1/chat/completions` dış erişime açılır. Proxy, en az 32 rastgele bayttan üretilen erişim anahtarı ister; anahtar/istek gövdeleri loglanmaz, upstream'e erişim anahtarı iletilmez. Otomatik yeniden gönderim veya alternatif upstream yoktur. TLS doğrulaması kapatılmaz.
4. `ai.menugo.app` DNS yalnız gerçek sunucu adresi ve sertifika doğrulandıktan sonra ayarlanır. Şu an müşterinin/restoranın mevcut DNS kayıtları değiştirilmedi.
5. Sahip rolü LLM Asistanı ekranında kendi sunucusunun anahtarını kaydeder. Bu anahtar ücretli bir LLM sağlayıcı anahtarı değildir; Vault'ta tutulur. Tarayıcıya geri verilmez.
6. Küçük bağlantı testi sonrası gerçek Türkçe menü görüntüleri, açıklama/çeviri ve sentetik fatura örnekleriyle kabul testi yapılır. Sadece MENUGO_OK yanıtı bütün işlerin kalite kabulü sayılmaz.

Uygulama talebi 45 saniyelik ağ sınırına, 90 saniyelik LLM lease'ine ve stüdyoda 120 saniyelik lease'e sahiptir. Model önceden ısıtılmalı; en yoğun pilot belge üzerinde süre/bellek test edilmelidir. Düşük donanımda süre aşılıyorsa sınırı körlemesine artırmak yerine kalıcı ayrı worker'a geçilmelidir. Timeout sonucu `unknown` olarak korunur; ikinci otomatik üretim başlatılmaz. JSON schema desteği yoksa düz metni başarılı çıktı kabul etmeyiz.

## Yayın sırası

Önce branch CI + gerçek PostgreSQL migration testleri + Edge type check; ardından `20260919002200_ops_open_source_llm.sql`, `menugo-llm` Edge dosyalarının tamamı, son olarak test edilmiş frontend main dalına birleştirilir. Yeni provider key veya model sunucusu olmadan panel doğrulama gerektiğini söyler ve üretim açılmaz. Eski provider kayıtları/sonuçları silinmez, ancak yeni ücretli çağrı claim/dispatch aşamasında reddedilir.

Bu belgede gerçek model testi sonucu yok. Birim testleri sahte ağ yanıtlarıyla protokolü, izolasyonu ve hata yolunu test eder. Tam suite tamamlanma kaydı açık kalır. Kaynak aktarımı için kullanılan tek-seferlik Python betikleri ana dalda otomatik çalıştırılmaz; ürettikleri normal TS/SQL değişiklikleri ayrı commit'te incelenir.

## Birincil kaynaklar (19.09.2026)
- https://huggingface.co/Qwen/Qwen3.5-4B
- https://huggingface.co/Qwen/Qwen3.5-9B
- https://docs.ollama.com/api/openai-compatibility
- https://docs.ollama.com/faq
- https://huggingface.co/Qwen/Qwen-Image-Edit

Ollama OpenAI-compatible API biçimi ücretli OpenAI hizmeti kullanıldığı anlamına gelmez; uygulamanın URL'si yalnız kendi HTTPS model servisidir.
