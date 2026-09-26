import { placeholderMobileMoneyCredentialsSchema } from "../mobile-money/base";
import { PlaceholderMobileMoneyAdapter } from "../mobile-money/base";
import type { ProviderHttpTransport } from "../types";
import { airtelMoneyConfigSchema } from "./config";
import {
  airtelMoneyErrorMap,
  airtelMoneyStatusMap
} from "./mapping";

export class AirtelMoneyProvider extends PlaceholderMobileMoneyAdapter {
  constructor(input: {
    channelId: string;
    config: unknown;
    countryCode: string;
    credentials: unknown;
    transport: ProviderHttpTransport;
  }) {
    super({
      channelId: input.channelId,
      config: airtelMoneyConfigSchema.parse(input.config),
      countryCode: input.countryCode,
      credentials: placeholderMobileMoneyCredentialsSchema.parse(
        input.credentials
      ),
      errorMap: airtelMoneyErrorMap,
      providerCode: "airtel_money",
      signatureHeader: "x-airtel-signature",
      statusMap: airtelMoneyStatusMap,
      transport: input.transport
    });
  }
}
