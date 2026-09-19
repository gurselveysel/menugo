export const llmMessages:Record<string,string>={
 PLATFORM_ADMIN_REQUIRED:'Bu alan yalnız MenüGO şirket yönetimine açıktır.',
 LLM_FREE_SETTINGS_REQUIRED:'Teknik yapılandırmayı yalnız MenüGO şirket yönetimi değiştirebilir.',
 LLM_PAID_PROVIDER_BLOCKED:'Ücretli sağlayıcılar ve otomatik kredi alımı kapalı.',
 LLM_FREE_PLAN_RECONFIRM:'Teknik bağlantının MenüGO şirket yönetimince kontrol edilmesi gerekiyor.',
 LLM_NO_ELIGIBLE_FREE_ROUTE:'Bu işlem için uygun AI hizmeti şu anda kullanılamıyor. Biraz sonra yeniden deneyin.',
 LLM_FREE_QUOTA_WAIT:'Ücretsiz kota veya bağlantı bekleniyor. İş beklemede; ücretli modele geçilmedi. Daha sonra yeni bir deneme başlatılabilir.',
 LLM_CAPABILITY_UNAVAILABLE:'Seçilen ücretsiz model bu dosya türünü desteklemiyor.',
 LLM_ACCOUNT_REQUIRED:'Cloudflare Account ID alanını kontrol edin.',

 LLM_SERVER_REQUIRED:'AI hizmeti MenüGO tarafından hazırlanıyor. Mevcut menü ve siparişleriniz etkilenmez.',
 LLM_OPEN_SOURCE_REQUIRED:'Bu sürüm yalnız ücretsiz model yönlendiricisini veya kendi açık model sunucunuzu kullanır. Ücretli API’ye otomatik geçiş yapılmaz.',
 LLM_PDF_PAGES_REQUIRED:'Bu açık kaynak bağlantısı görüntü kabul ediyor. PDF sayfalarını fotoğraf/görüntü olarak yükleyin; doğrudan PDF dönüştürme henüz bağlı değil.',
 LLM_IMAGE_ENGINE_REQUIRED:'Ürün fotoğrafı üretimi ayrı bir görsel model sunucusu gerektirir. Metin modeli bu işlemi yapmaz; ücretli modele geçilmedi.',
 LLM_KEY_REQUIRED:'Bu AI hizmeti henüz kullanıma açılmadı. MenüGO desteğiyle iletişime geçin.',
 LLM_TEST_REQUIRED:'AI hizmetinin kontrolü MenüGO tarafından tamamlanıyor.',
 LLM_DISABLED:'Bu işletmenin LLM bağlantısı durdurulmuş.',LLM_KEY_INVALID:'Sağlayıcı anahtarı reddetti. Anahtarı ve API erişim yetkisini kontrol edin.',
 LLM_CREDIT_REQUIRED:'Seçilen sağlayıcıda API kredisi/kotası yeterli değil. Otomatik kredi satın alınmadı.',
 LLM_RATE_LIMIT:'Sağlayıcı veya şube istek sınırına ulaşıldı. Biraz sonra yeni bir deneme başlatın.',LLM_DAILY_LIMIT:'Şubenin günlük LLM deneme sınırına ulaşıldı.',LLM_BUSY:'Başka LLM işlemleri devam ediyor. Biraz bekleyin.',
 LLM_RESULT_UNKNOWN:'Yanıt kesinleşmedi. Aynı işlemi kontrol etmek yeni model çağrısı yapmaz. Yeni deneme ise ek kullanım oluşturabilir.',
 LLM_SAVE_UNKNOWN:'Model yanıtının kaydı doğrulanamadı. Aynı işlemi kontrol edin; otomatik ikinci çağrı yapılmaz.',
 LLM_IN_PROGRESS:'Bu işlem hâlâ sürüyor. Aynı işlemi biraz sonra kontrol edin.',LLM_RESULT_EXPIRED:'Bu yanıtın 24 saatlik saklama süresi doldu. Aynı anahtarla yeniden ücretli çağrı yapılmaz.',
 LLM_CONFIG_CHANGED:'Bağlantı başka bir işlemle değişti. Sayfayı yenileyin.',LLM_INVALID_OUTPUT:'Model yanıtı veri kontrolünü geçemedi; menü değiştirilmedi.',
 LLM_INVALID_REFERENCE:'Model, verilen kaynaklar dışında bir kayıt işaretledi. Yanıt gösterilmedi.',LLM_OUTPUT_INCOMPLETE:'Model yanıtı tamamlanmadı. Otomatik tekrar yapılmadı.',LLM_PROVIDER_UNAVAILABLE:'LLM sağlayıcısına ulaşılamadı.',
 LLM_CONNECTION_UNAVAILABLE:'LLM sunucu bağlantısına ulaşılamadı.',LLM_PRODUCT_REQUIRED:'Önce ilgili ürünü seçin.',LLM_TEST_FAILED:'Model bağlantı testini tamamlayamadı.',LLM_REFUSAL:'Model bu isteği yanıtlayamadı.',
 OWNER_REQUIRED:'Bu işlem için MenüGO şirket yönetimi yetkisi gerekiyor.',MANAGER_REQUIRED:'Bu alan işletme sahibi ve yöneticiler içindir.',
 INVALID_LLM_KEY:'Geçerli bir API anahtarı girin.',INVALID_LLM_SETTINGS:'Sağlayıcı, model, limit ve kullanım onayını kontrol edin.',INVALID_LLM_REQUEST:'İstek alanlarını kontrol edin.',
 IDEMPOTENCY_CONFLICT:'Bu işlem anahtarı farklı içerikle kullanılmış. Önce mevcut işlemi kontrol edin.',AI_CREDIT_REQUIRED:'Ücretli sağlayıcı kapalı. Uygun ücretsiz bağlantı ve kota bekleniyor.'
};
export function llmMessage(e:unknown){const code=e instanceof Error?e.message:'';return llmMessages[code]||'İşlem tamamlanamadı. Modelin fiyat, sipariş veya ödeme değiştirme yetkisi yoktur.';}
export const llmModels={openrouter_free:[['openrouter/free','OpenRouter · Ücretsiz Modeller Router']],self_hosted:[['qwen3.5:4b','Qwen3.5 4B · Ollama'],['qwen3.5:9b','Qwen3.5 9B · Ollama'],['Qwen/Qwen3.5-4B','Qwen3.5 4B · vLLM'],['Qwen/Qwen3.5-9B','Qwen3.5 9B · vLLM']],openai:[['gpt-4.1-mini','GPT-4.1 mini'],['gpt-4.1','GPT-4.1']],gemini:[['gemini-2.5-flash','Gemini 2.5 Flash']]} as const;
export interface LlmStatus {configured:boolean;enabled:boolean;provider:'openai'|'gemini'|'self_hosted'|'openrouter_free'|'free_router'|null;model:string|null;version:string;canManage:boolean;verified:boolean|null;testedAt:string|null;testError:string|null;dailyLimit:number;usedToday:number;imageConfigured?:boolean;freeOnly?:boolean;}
