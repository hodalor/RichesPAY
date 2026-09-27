import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SimulatorBankPayoutProvider,
  SimulatorCardAcquirer,
  SimulatorMobileMoneyProvider
} from "../src/providers";

describe("simulator mobile money provider", () => {
  const provider = new SimulatorMobileMoneyProvider();

  it("uses the documented magic endings", async () => {
    const successAfterFive = await provider.collect({
      amount: 1500,
      context: {
        mode: "test",
        requestId: "req_0001"
      },
      currency: "GHS",
      msisdn: "+233244560001",
      reference: "col_0001"
    });
    expect(successAfterFive.outcome).toBe("accepted");
    expect(successAfterFive.rawRedacted).toMatchObject({
      callback_after_seconds: 5
    });

    const insufficientFunds = await provider.collect({
      amount: 1500,
      context: {
        mode: "test",
        requestId: "req_0002"
      },
      currency: "GHS",
      msisdn: "+233244560002",
      reference: "col_0002"
    });
    expect(insufficientFunds.outcome).toBe("failed");
    expect(insufficientFunds.failureCode).toBe("insufficient_funds");

    const pendingNoCallback = await provider.collect({
      amount: 1500,
      context: {
        mode: "test",
        requestId: "req_0003"
      },
      currency: "GHS",
      msisdn: "+233244560003",
      reference: "col_0003"
    });
    expect(pendingNoCallback.outcome).toBe("accepted");
    expect(pendingNoCallback.rawRedacted).toMatchObject({
      no_callback: true
    });
    await expect(
      provider.getStatus(String(pendingNoCallback.providerRef))
    ).resolves.toMatchObject({
      outcome: "succeeded"
    });

    const customerDeclined = await provider.collect({
      amount: 1500,
      context: {
        mode: "test",
        requestId: "req_0004"
      },
      currency: "GHS",
      msisdn: "+233244560004",
      reference: "col_0004"
    });
    expect(customerDeclined.outcome).toBe("failed");
    expect(customerDeclined.providerStatus).toBe("customer_declined");

    const timeoutThenStatusSuccess = await provider.collect({
      amount: 1500,
      context: {
        mode: "test",
        requestId: "req_0005"
      },
      currency: "GHS",
      msisdn: "+233244560005",
      reference: "col_0005"
    });
    expect(timeoutThenStatusSuccess.outcome).toBe("unknown");
    await expect(
      provider.getStatus(String(timeoutThenStatusSuccess.providerRef))
    ).resolves.toMatchObject({
      outcome: "succeeded"
    });

    const defaultSuccess = await provider.collect({
      amount: 1500,
      context: {
        mode: "test",
        requestId: "req_default"
      },
      currency: "ZMW",
      msisdn: "+260977120099",
      reference: "col_default"
    });
    expect(defaultSuccess.outcome).toBe("accepted");
    expect(defaultSuccess.rawRedacted).toMatchObject({
      callback_after_seconds: 3
    });
  });

  it("parses and verifies simulator callbacks", async () => {
    const callbackBody = JSON.stringify({
      event_id: "sim_evt_callback",
      event_type: "collection.updated",
      provider_ref: "sim_collect_callback_success_3s_col_default",
      resource_id: "col_default",
      resource_type: "collection",
      status: "succeeded",
      to_status: "succeeded"
    });
    const signature = createHmac(
      "sha256",
      "richespay_simulator_callback_secret"
    )
      .update(callbackBody)
      .digest("hex");

    expect(
      provider.verifyCallback({
        headers: {
          "x-richespay-simulator-signature": signature
        },
        ip: "127.0.0.1",
        rawBody: callbackBody
      })
    ).toBe(true);

    expect(
      provider.verifyCallback({
        headers: {
          "x-richespay-simulator-signature": "bad"
        },
        ip: "127.0.0.1",
        rawBody: callbackBody
      })
    ).toBe(false);

    await expect(provider.parseCallback(callbackBody)).resolves.toMatchObject({
      eventId: "sim_evt_callback",
      providerRef: "sim_collect_callback_success_3s_col_default",
      toStatus: "succeeded"
    });
  });
});

describe("simulator card acquirer", () => {
  const provider = new SimulatorCardAcquirer({
    checkout_origin: "http://127.0.0.1:5175"
  });

  it("returns hosted fields next actions for test card entry", async () => {
    const session = await provider.createPaymentSession({
      amount: 5000,
      callbackUrl: "http://127.0.0.1:3000/callbacks/chn_simulator_card_test",
      context: {
        mode: "test",
        requestId: "req_card_0001"
      },
      currency: "GHS",
      reference: "col_card_0001",
      returnUrl: "http://127.0.0.1:5175/session/cs_card_0001"
    });

    expect(session.outcome).toBe("accepted");
    expect(session.providerStatus).toBe("pending");
    expect(session.nextAction).toMatchObject({
      iframe_url: expect.stringContaining("/simulator/card-fields?"),
      type: "hosted_fields"
    });
    expect(session.rawRedacted).toMatchObject({
      simulator: {
        accepted_cards: [
          "4000000000000001",
          "4000000000000002",
          "4000000000000003"
        ],
        hosted_fields: true
      }
    });
  });

  it("maps declined and successful card statuses", async () => {
    await expect(provider.getStatus("sim_card_col_card_0002_declined")).resolves.toMatchObject(
      {
        failureCode: "provider_error",
        outcome: "failed",
        providerStatus: "declined"
      }
    );

    await expect(provider.getStatus("sim_card_col_card_0001")).resolves.toMatchObject({
      outcome: "succeeded",
      providerStatus: "succeeded"
    });
  });

  it("parses and verifies simulator card callbacks with masked card data", async () => {
    const callbackBody = JSON.stringify({
      event_type: "collection.updated",
      payment_instrument: {
        brand: "visa",
        expiry_month: 3,
        expiry_year: 2028,
        last4: "0003"
      },
      provider_ref: "sim_card_col_card_0003",
      resource_id: "col_card_0003",
      resource_type: "collection",
      to_status: "succeeded"
    });
    const signature = createHmac(
      "sha256",
      "richespay_simulator_callback_secret"
    )
      .update(callbackBody)
      .digest("hex");

    expect(
      provider.verifyCallback({
        headers: {
          "x-richespay-simulator-signature": signature
        },
        ip: "127.0.0.1",
        rawBody: callbackBody
      })
    ).toBe(true);

    await expect(provider.parseCallback(callbackBody)).resolves.toMatchObject({
      providerRef: "sim_card_col_card_0003",
      rawRedacted: {
        payment_instrument: {
          brand: "visa",
          expiry_month: 3,
          expiry_year: 2028,
          last4: "0003"
        }
      },
      resourceId: "col_card_0003",
      toStatus: "succeeded"
    });
  });
});

describe("simulator bank payout provider", () => {
  const provider = new SimulatorBankPayoutProvider();

  it("uses the documented bank account endings", async () => {
    const success = await provider.payout({
      accountNumber: "1234560001",
      amount: 5000,
      bankCode: "GCB",
      context: {
        mode: "test",
        requestId: "req_bank_0001"
      },
      currency: "GHS",
      reference: "pay_bank_0001"
    });
    expect(success.outcome).toBe("accepted");

    const insufficientFunds = await provider.payout({
      accountNumber: "1234560002",
      amount: 5000,
      bankCode: "GCB",
      context: {
        mode: "test",
        requestId: "req_bank_0002"
      },
      currency: "GHS",
      reference: "pay_bank_0002"
    });
    expect(insufficientFunds.outcome).toBe("failed");
    expect(insufficientFunds.failureCode).toBe("insufficient_funds");

    const pendingNoCallback = await provider.payout({
      accountNumber: "1234560003",
      amount: 5000,
      bankCode: "GCB",
      context: {
        mode: "test",
        requestId: "req_bank_0003"
      },
      currency: "GHS",
      reference: "pay_bank_0003"
    });
    expect(pendingNoCallback.outcome).toBe("accepted");
    expect(pendingNoCallback.rawRedacted).toMatchObject({
      no_callback: true
    });
    await expect(provider.getStatus(String(pendingNoCallback.providerRef))).resolves.toMatchObject(
      {
        outcome: "succeeded"
      }
    );

    const accountRejected = await provider.payout({
      accountNumber: "1234560004",
      amount: 5000,
      bankCode: "GCB",
      context: {
        mode: "test",
        requestId: "req_bank_0004"
      },
      currency: "GHS",
      reference: "pay_bank_0004"
    });
    expect(accountRejected.outcome).toBe("failed");
    expect(accountRejected.providerStatus).toBe("account_rejected");

    const timeoutThenStatusSuccess = await provider.payout({
      accountNumber: "1234560005",
      amount: 5000,
      bankCode: "GCB",
      context: {
        mode: "test",
        requestId: "req_bank_0005"
      },
      currency: "GHS",
      reference: "pay_bank_0005"
    });
    expect(timeoutThenStatusSuccess.outcome).toBe("unknown");
    await expect(provider.getStatus(String(timeoutThenStatusSuccess.providerRef))).resolves.toMatchObject(
      {
        outcome: "succeeded"
      }
    );
  });
});
