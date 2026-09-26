import { placeholderMobileMoneyCredentialsSchema } from "../mobile-money/base";
import { PlaceholderMobileMoneyAdapter } from "../mobile-money/base";
import type { ProviderHttpTransport } from "../types";
import { telecelCashConfigSchema } from "./config";
import {
  telecelCashErrorMap,
  telecelCashStatusMap
} from "./mapping";

export class TelecelCashProvider extends PlaceholderMobileMoneyAdapter {
  constructor(input: {
    channelId: string;
    config: unknown;
    countryCode: string;
    credentials: unknown;
    transport: ProviderHttpTransport;
  }) {
    super({
      channelId: input.channelId,
      config: telecelCashConfigSchema.parse(input.config),
      countryCode: input.countryCode,
      credentials: placeholderMobileMoneyCredentialsSchema.parse(
        input.credentials
      ),
      errorMap: telecelCashErrorMap,
      providerCode: "telecel_cash",
      signatureHeader: "x-telecel-signature",
      statusMap: telecelCashStatusMap,
      transport: input.transport
    });
  }
}
