export const llmMessages:Record<string,string>={
 LLM_KEY_REQUIRED:'Bir LLM sağlayıcısı bağlayın. API anahtarını yalnızca aşağıdaki güvenli bağlantı alanına girin; sohbet mesajına yazmayın.',
 LLM_TEST_REQUIRED:'Bağlantı kaydedildi. Kullanmadan önce “Bağlantıyı test et” ile modeli doğrulayın.',
 LLM_DISABLED:'Bu işletmenin LLM bağlantısı durdurulmuş.',LLM_KEY_INVALID:'Sağlayıcı anahtarı reddetti. Anahtarı ve API erişim yetkisini kontrol edin.',
 LLM_CREDIT_REQUIRED:'Seçilen sağlayıcıda API kredisi/kotası yeterli değil. Otomatik kredi satın alınmadı.',
 LLM_RATE_LIMIT:'Sağlayıcı veya şube istek sınırına ulaşıldı. Biraz sonra yeni bir deneme başlatın.',LLM_DAILY_LIMIT:'Şubenin günlük LLM deneme sınırına ulaşıldı.',LLM_BUSY:'Başka LLM işlemleri devam ediyor. Biraz bekleyin.',
 LLM_RESULT_UNKNOWN:'Yanıt kesinleşmedi. Aynı işlemi kontrol etmek yeni model çağrısı yapmaz. Yeni deneme ise ek kullanım oluşturabilir.',
 LLM_SAVE_UNKNOWN:'Model yanıtının kaydı doğrulanamadı. Aynı işlemi kontrol edin; otomatik ikinci çağrı yapılmaz.',
 LLM_IN_PROGRESS:'Bu işlem hâlâ sürüyor. Aynı işlemi biraz sonra kontrol edin.',LLM_RESULT_EXPIRED:'Bu yanıtın 24 saatlik saklama süresi doldu. Aynı anahtarla yeniden ücretli çağrı yapılmaz.',
 LLM_CONFIG_CHANGED:'Bağlantı başka bir işlemle değişti. Sayfayı yenileyin.',LLM_INVALID_OUTPUT:'Model yanıtı veri kontrolünü geçemedi; menü değiştirilmedi.',
 LLM_INVALID_REFERENCE:'Model, verilen kaynaklar dışında bir kayıt işaretledi. Yanıt gösterilmedi.',LLM_OUTPUT_INCOMPLETE:'Model yanıtı tamamlanmadı. Otomatik tekrar yapılmadı.',LLM_PROVIDER_UNAVAILABLE:'LLM sağlayıcısına ulaşılamadı.',
 LLM_CONNECTION_UNAVAILABLE:'LLM sunucu bağlantısına ulaşılamadı.',LLM_PRODUCT_REQUIRED:'Önce ilgili ürünü seçin.',LLM_TEST_FAILED:'Model bağlantı testini tamamlayamadı.',LLM_REFUSAL:'Model bu isteği yanıtlayamadı.',
 OWNER_REQUIRED:'Sağlayıcı ve anahtar değişikliklerini yalnızca işletme sahibi yapabilir.',MANAGER_REQUIRED:'Bu alan işletme sahibi ve yöneticiler içindir.',
 INVALID_LLM_KEY:'Geçerli bir API anahtarı girin.',INVALID_LLM_SETTINGS:'Sağlayıcı, model, limit ve kullanım onayını kontrol edin.',INVALID_LLM_REQUEST:'İstek alanlarını kontrol edin.',
 IDEMPOTENCY_CONFLICT:'Bu işlem anahtarı farklı içerikle kullanılmış. Önce mevcut işlemi kontrol edin.',AI_CREDIT_REQUIRED:'Vercel AI Gateway kredisi yok. Doğrudan bir LLM bağlantısı ekleyebilir veya Gateway hesabını etkinleştirebilirsiniz.'
};
export function llmMessage(e:unknown){const code=e instanceof Error?e.message:'';return llmMessages[code]||'İşlem tamamlanamadı. Modelin fiyat, sipariş veya ödeme değiştirme yetkisi yoktur.';}
export const llmModels={openai:[['gpt-4.1-mini','GPT-4.1 mini'],['gpt-4.1','GPT-4.1']],gemini:[['gemini-2.5-flash','Gemini 2.5 Flash']]} as const;
export interface LlmStatus {configured:boolean;enabled:boolean;provider:'openai'|'gemini'|null;model:string|null;version:string;canManage:boolean;verified:boolean|null;testedAt:string|null;testError:string|null;dailyLimit:number;usedToday:number;}
