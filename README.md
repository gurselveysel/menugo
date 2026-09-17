# MenüGO

Yeni Nesil Dijital Menü — Next.js, TypeScript, Supabase.

## Çalıştırma

Node 22/24. `npm ci` (kilit dosyası yoksa `npm install`), `npm run test:sql`, `npm test`, `npm run build`, `npm start`.

## r6

- Supabase üzerinde onaylı fiyat ve stok uygunluğu.
- Yönetici menü/fiyat ekranı, masa QR katılımı, ortak sepet, mutfak kuyruğu.
- Kasada gerçekten alınmış nakit/harici POS tutarının append-only kaydı ve atomik masa kapatma.
- Kişi bazlı hesap paylaşımı; PSP, kurye ve SMS için kapalı güvenlik kapıları.

Mevcut veritabanında eski migration'ları tekrar çalıştırmayın. r6 migration sonrası pilot kabul testleri yapılmalıdır.
Supabase publishable anahtarı frontend için tasarlanmıştır; service-role, veritabanı parolası veya müşteri verisi bu depoda bulunmaz.
`docs/pilot-r6.md` işletim ve eksik sağlayıcı bağlantılarını açıklar.

Testler gerçek SQL motorlu izole PGlite ortamında çalışır; Auth/Realtime taklitleri canlı dört telefon testinin yerine geçmez.

Tüm hakları saklıdır. Public depo açık kaynak lisansı değildir.
