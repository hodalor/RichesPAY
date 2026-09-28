import {
  HttpAirtimeAdapter,
  buildAirtimeAdapterInput,
  type AirtimeChannelAdapterInput
} from "../airtime/base";

// TODO(spec): Replace the placeholder paths, signature header and error codes
// with the Zamtel airtime (ZM) specification once docs/providers/zamtel_airtime.md exists.
export class ZamtelAirtimeProvider extends HttpAirtimeAdapter {
  constructor(input: AirtimeChannelAdapterInput) {
    super(
      buildAirtimeAdapterInput({
        ...input,
        providerCode: "zamtel_airtime",
        signatureHeader: "x-zamtel-signature"
      })
    );
  }
}
