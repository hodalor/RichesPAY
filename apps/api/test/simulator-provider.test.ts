import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SimulatorMobileMoneyProvider } from "../src/providers";

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
