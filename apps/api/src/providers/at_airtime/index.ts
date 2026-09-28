import {
  HttpAirtimeAdapter,
  buildAirtimeAdapterInput,
  type AirtimeChannelAdapterInput
} from "../airtime/base";

// TODO(spec): Replace the placeholder paths, signature header and error codes
// with the AT airtime (GH) specification once docs/providers/at_airtime.md exists.
export class AtAirtimeProvider extends HttpAirtimeAdapter {
  constructor(input: AirtimeChannelAdapterInput) {
    super(
      buildAirtimeAdapterInput({
        ...input,
        providerCode: "at_airtime",
        signatureHeader: "x-at-signature"
      })
    );
  }
}
