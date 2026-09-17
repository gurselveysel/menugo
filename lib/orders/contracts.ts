/** Domain money/revisions are bigint; the wire representation is a decimal integer string. */
export const PG_BIGINT_MAX = 9223372036854775807n;
export type CartInput = {
  operationId: string;
  productId: string;
  delta: number; // Quantity delta, NOT money.
  expectedRevision: string;
};
export type Scope = { businessId: string; branchId: string };
export type CheckRouteContext = { params: Promise<{ checkId: string }> };
export type CartResult = {
  checkId: string;
  operationId: string;
  revision: bigint;
  currency: 'TRY';
  totalMinor: bigint;
  lines: Array<{
    cartLineId: string;
    productId: string;
    productName: string;
    quantity: number;
    unitPriceMinor: bigint;
    lineTotalMinor: bigint;
  }>;
};
export type OrderResult = {
  checkId: string;
  operationId: string;
  orderId: string;
  revision: bigint;
  status: 'submitted';
  currency: 'TRY';
  totalMinor: bigint;
  chargeCount: number;
  lines: Array<{
    orderItemId: string;
    productId: string;
    productName: string;
    quantity: number;
    unitPriceMinor: bigint;
    discountMinor: bigint;
    grossMinor: bigint;
    netMinor: bigint;
  }>;
};
