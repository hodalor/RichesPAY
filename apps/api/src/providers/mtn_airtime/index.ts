import {
  HttpAirtimeAdapter,
  buildAirtimeAdapterInput,
  type AirtimeChannelAdapterInput
} from "../airtime/base";

// TODO(spec): Replace the placeholder paths, signature header and error codes
// with the MTN airtime (GH/ZM) specification once docs/providers/mtn_airtime.md exists.
export class MtnAirtimeProvider extends HttpAirtimeAdapter {
  constructor(input: AirtimeChannelAdapterInput) {
    super(
      buildAirtimeAdapterInput({
        ...input,
        providerCode: "mtn_airtime",
        signatureHeader: "x-mtn-signature"
      })
    );
  }
}
