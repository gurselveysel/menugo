export interface CurrencyScope {
  readonly businessId: string;
  readonly branchId: string;
  readonly operationId: string; // same UUID on retry; never regenerate on timeout
  readonly sourceRef: string; // immutable payer-share settlement or checkout share ID
  readonly actor: Readonly<
    { kind: 'customer'; userId: string } |
    { kind: 'settlement-worker' }
  >;
}
