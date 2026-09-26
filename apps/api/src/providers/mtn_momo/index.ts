import { placeholderMobileMoneyCredentialsSchema } from "../mobile-money/base";
import { PlaceholderMobileMoneyAdapter } from "../mobile-money/base";
import type { ProviderHttpTransport } from "../types";
import { mtnMomoConfigSchema } from "./config";
import { mtnMomoErrorMap, mtnMomoStatusMap } from "./mapping";

export class MtnMomoProvider extends PlaceholderMobileMoneyAdapter {
  constructor(input: {
    channelId: string;
    config: unknown;
    countryCode: string;
    credentials: unknown;
    transport: ProviderHttpTransport;
  }) {
    super({
      channelId: input.channelId,
      config: mtnMomoConfigSchema.parse(input.config),
      countryCode: input.countryCode,
      credentials: placeholderMobileMoneyCredentialsSchema.parse(
        input.credentials
      ),
      errorMap: mtnMomoErrorMap,
      providerCode: "mtn_momo",
      signatureHeader: "x-mtn-signature",
      statusMap: mtnMomoStatusMap,
      transport: input.transport
    });
  }
}
