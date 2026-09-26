import { placeholderMobileMoneyCredentialsSchema } from "../mobile-money/base";
import { PlaceholderMobileMoneyAdapter } from "../mobile-money/base";
import type { ProviderHttpTransport } from "../types";
import { atMoneyConfigSchema } from "./config";
import { atMoneyErrorMap, atMoneyStatusMap } from "./mapping";

export class AtMoneyProvider extends PlaceholderMobileMoneyAdapter {
  constructor(input: {
    channelId: string;
    config: unknown;
    countryCode: string;
    credentials: unknown;
    transport: ProviderHttpTransport;
  }) {
    super({
      channelId: input.channelId,
      config: atMoneyConfigSchema.parse(input.config),
      countryCode: input.countryCode,
      credentials: placeholderMobileMoneyCredentialsSchema.parse(
        input.credentials
      ),
      errorMap: atMoneyErrorMap,
      providerCode: "at_money",
      signatureHeader: "x-at-signature",
      statusMap: atMoneyStatusMap,
      transport: input.transport
    });
  }
}
