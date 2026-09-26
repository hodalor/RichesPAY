import { placeholderMobileMoneyCredentialsSchema } from "../mobile-money/base";
import { PlaceholderMobileMoneyAdapter } from "../mobile-money/base";
import type { ProviderHttpTransport } from "../types";
import { zamtelMoneyConfigSchema } from "./config";
import {
  zamtelMoneyErrorMap,
  zamtelMoneyStatusMap
} from "./mapping";

export class ZamtelMoneyProvider extends PlaceholderMobileMoneyAdapter {
  constructor(input: {
    channelId: string;
    config: unknown;
    countryCode: string;
    credentials: unknown;
    transport: ProviderHttpTransport;
  }) {
    super({
      channelId: input.channelId,
      config: zamtelMoneyConfigSchema.parse(input.config),
      countryCode: input.countryCode,
      credentials: placeholderMobileMoneyCredentialsSchema.parse(
        input.credentials
      ),
      errorMap: zamtelMoneyErrorMap,
      providerCode: "zamtel_money",
      signatureHeader: "x-zamtel-signature",
      statusMap: zamtelMoneyStatusMap,
      transport: input.transport
    });
  }
}
