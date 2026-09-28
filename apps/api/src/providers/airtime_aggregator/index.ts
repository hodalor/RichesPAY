import {
  HttpAirtimeAdapter,
  buildAirtimeAdapterInput,
  type AirtimeChannelAdapterInput
} from "../airtime/base";

// TODO(spec): Replace the placeholder paths, signature header and error codes
// with the chosen backup aggregator's specification once
// docs/providers/airtime_aggregator.md exists. This channel is only a backup to
// the direct MNO channels and should carry a higher routing priority number.
export class AirtimeAggregatorProvider extends HttpAirtimeAdapter {
  constructor(input: AirtimeChannelAdapterInput) {
    super(
      buildAirtimeAdapterInput({
        ...input,
        providerCode: "airtime_aggregator",
        signatureHeader: "x-aggregator-signature"
      })
    );
  }
}
