import {
  HttpAirtimeAdapter,
  buildAirtimeAdapterInput,
  type AirtimeChannelAdapterInput
} from "../airtime/base";

// TODO(spec): Replace the placeholder paths, signature header and error codes
// with the Airtel airtime (ZM) specification once docs/providers/airtel_airtime.md exists.
export class AirtelAirtimeProvider extends HttpAirtimeAdapter {
  constructor(input: AirtimeChannelAdapterInput) {
    super(
      buildAirtimeAdapterInput({
        ...input,
        providerCode: "airtel_airtime",
        signatureHeader: "x-airtel-signature"
      })
    );
  }
}
