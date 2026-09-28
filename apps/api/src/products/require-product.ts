import { getErrorDefinition, type MerchantProduct } from "@richespay/shared";

import type { ScopedTransaction } from "../db";
import type { RpMode } from "../db/types";
import { ApiRouteError } from "../lib/api-error";

const productColumns = {
  airtime: "airtime_enabled",
  collections: "collections_enabled",
  payouts: "payouts_enabled",
  sms: "sms_enabled"
} as const satisfies Record<MerchantProduct, string>;

// Merchants created before a product existed have no explicit opt-in, so only
// the original launch products default to on when the row is missing.
const enabledWhenRowMissing: Record<MerchantProduct, boolean> = {
  airtime: false,
  collections: true,
  payouts: true,
  sms: true
};

const productLabels: Record<MerchantProduct, string> = {
  airtime: "airtime",
  collections: "collections",
  payouts: "payouts",
  sms: "SMS"
};

export interface ProductScope {
  merchantId: string;
  mode: RpMode;
}

export async function isProductEnabled(
  trx: ScopedTransaction,
  scope: ProductScope,
  product: MerchantProduct
): Promise<boolean> {
  const column = productColumns[product];
  const row = await trx
    .selectFrom("merchant_products")
    .select([column])
    .where("merchant_id", "=", scope.merchantId)
    .where("mode", "=", scope.mode)
    .executeTakeFirst();

  if (!row) {
    return enabledWhenRowMissing[product];
  }

  return (row as Record<typeof column, boolean>)[column] === true;
}

export async function requireProduct(
  trx: ScopedTransaction,
  scope: ProductScope,
  product: MerchantProduct
): Promise<void> {
  if (await isProductEnabled(trx, scope, product)) {
    return;
  }

  throw new ApiRouteError({
    code: "product_not_enabled",
    message: `The ${productLabels[product]} product is not enabled for this merchant.`,
    statusCode: getErrorDefinition("product_not_enabled").status
  });
}
