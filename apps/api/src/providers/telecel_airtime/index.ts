import {
  HttpAirtimeAdapter,
  buildAirtimeAdapterInput,
  type AirtimeChannelAdapterInput
} from "../airtime/base";

// TODO(spec): Replace the placeholder paths, signature header and error codes
// with the Telecel airtime (GH) specification once docs/providers/telecel_airtime.md exists.
export class TelecelAirtimeProvider extends HttpAirtimeAdapter {
  constructor(input: AirtimeChannelAdapterInput) {
    super(
      buildAirtimeAdapterInput({
        ...input,
        providerCode: "telecel_airtime",
        signatureHeader: "x-telecel-signature"
      })
    );
  }
}
