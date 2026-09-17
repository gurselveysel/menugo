export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** PostgreSQL messages are matched against an allowlist; never expose raw SQL/details. */
export function fromDatabaseError(error: {
  code?: string;
  message?: string;
  details?: string | null;
}): ApiError {
  const known: Record<string, [number, string]> = {
    UNAUTHENTICATED: [401, 'Oturum açmanız gerekiyor.'],
    INVALID_COMMAND: [400, 'İşlem bilgileri geçersiz.'],
    INVALID_CART_INPUT: [400, 'Sepet isteği geçersiz.'],
    CHECK_NOT_FOUND: [404, 'Adisyon bulunamadı.'],
    CHECK_NOT_FOUND_IN_SCOPE: [404, 'Adisyon bulunamadı.'],
    PRODUCT_NOT_FOUND: [404, 'Ürün bulunamadı.'],
    IDEMPOTENCY_CONFLICT: [409, 'İşlem anahtarı farklı bir istekte kullanılmış.'],
    REVISION_CONFLICT: [409, 'Sepet değişti. Güncel sepeti kontrol edin.'],
    STALE_CHECK_REVISION: [409, 'Sepet değişti. Güncel sepeti kontrol edin.'],
    CHECK_NOT_OPEN: [409, 'Bu adisyon değiştirilemez.'],
    ORDERING_DISABLED: [409, 'Bu şubede sipariş kanalı kapalı.'],
    TABLE_INACTIVE: [409, 'Masa şu anda kullanıma açık değil.'],
    PRODUCT_NOT_ORDERABLE: [409, 'Ürün şu anda siparişe uygun değil.'],
    OPTIONS_NOT_SUPPORTED: [409, 'Bu ürün için seçenekli sipariş henüz desteklenmiyor.'],
    INVALID_CATALOG_PRICE: [409, 'Ürünün satış fiyatı yapılandırılmalı.'],
    PRICE_CHANGED: [409, 'Ürün fiyatı değişti. Yeniden onaylamadan sipariş verilemez.'],
    CART_LINE_NOT_FOUND: [409, 'Azaltılacak ürün sepette bulunamadı.'],
    CART_EMPTY: [409, 'Sepet boş.'],
    QUANTITY_OUT_OF_RANGE: [422, 'Ürün adedi izin verilen aralığın dışında.'],
    CART_LIMIT_EXCEEDED: [422, 'Sepet en fazla 100 satır ve 500 adet içerebilir.'],
    AMOUNT_LIMIT_EXCEEDED: [422, 'Toplam tutar sistem sınırını aşıyor.'],
  };
  const match = error.message ? known[error.message] : undefined;
  if (match) {
    const details: Record<string, string> = {};
    // Whitelist both the message and the shape of structured details.
    if (error.details && ['REVISION_CONFLICT', 'PRICE_CHANGED'].includes(error.message!)) {
      try {
        const parsed = JSON.parse(error.details) as Record<string, unknown>;
        if (typeof parsed.currentRevision === 'string' && /^(0|[1-9]\d{0,18})$/.test(parsed.currentRevision))
          details.currentRevision = parsed.currentRevision;
        if (typeof parsed.productId === 'string' && /^[a-f0-9-]{36}$/i.test(parsed.productId))
          details.productId = parsed.productId;
        if (typeof parsed.currentUnitPriceMinor === 'string' && /^(0|[1-9]\d{0,18})$/.test(parsed.currentUnitPriceMinor))
          details.currentUnitPriceMinor = parsed.currentUnitPriceMinor;
      } catch { /* Never forward an unstructured database detail. */ }
    }
    return new ApiError(match[0], error.message!, match[1], details);
  }
  if (['55P03', '57014', '40001', '40P01'].includes(error.code ?? '')) {
    return new ApiError(503, 'RETRY_SAME_OPERATION',
      'İşlem tamamlanamadı. Aynı işlem anahtarı ve aynı içerikle tekrar deneyin.');
  }
  if (error.code === 'PGRST301' || error.code === 'PGRST303') {
    return new ApiError(401, 'UNAUTHENTICATED', 'Oturumunuz yenilenmeli.');
  }
  return new ApiError(500, 'DATABASE_OPERATION_FAILED', 'İşlem tamamlanamadı.');
}
