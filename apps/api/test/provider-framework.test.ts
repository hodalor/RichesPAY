import { describe, expect, it } from "vitest";

import {
  ChannelCircuitBreaker,
  ChannelRouter,
  executeWithFailover
} from "../src/providers";

import type { ChannelRecord, RoutingRuleRecord } from "../src/providers";

describe("provider channel framework", () => {
  it("picks the first active healthy routed live channel and always uses simulator in test mode", async () => {
    const liveChannel: ChannelRecord = {
      capabilities: ["collect"],
      config: {},
      countryCode: "GH",
      credentialsEncrypted: "enc",
      health: "healthy",
      id: "chn_live_primary",
      kind: "mobile_money",
      mode: "live",
      network: "mtn",
      priority: 10,
      providerCode: "mtn_momo",
      status: "active"
    };
    const unhealthyChannel: ChannelRecord = {
      ...liveChannel,
      health: "down",
      id: "chn_live_unhealthy",
      priority: 1
    };
    const simulatorChannel: ChannelRecord = {
      ...liveChannel,
      id: "chn_test_simulator",
      mode: "test",
      network: null,
      providerCode: "simulator"
    };
    const rule: RoutingRuleRecord = {
      capability: "collect",
      channelIds: [unhealthyChannel.id, liveChannel.id],
      countryCode: "GH",
      kind: "mobile_money",
      network: "mtn"
    };

    const router = new ChannelRouter({
      async getSimulatorChannel() {
        return simulatorChannel;
      },
      async listChannels() {
        return [unhealthyChannel, liveChannel];
      },
      async loadRoutingRule() {
        return rule;
      }
    });

    await expect(
      router.pick("mobile_money", "collect", "GH", "mtn", "live")
    ).resolves.toMatchObject({
      id: liveChannel.id
    });

    await expect(
      router.pick("mobile_money", "collect", "GH", "mtn", "test")
    ).resolves.toMatchObject({
      id: simulatorChannel.id
    });
  });

  it("opens the circuit after five hard failures in sixty seconds and half-opens after two minutes", async () => {
    let now = 0;
    const redisStore = new Map<string, string>();
    const redis = {
      async get(key: string) {
        return redisStore.get(key) ?? null;
      },
      async set(key: string, value: string) {
        redisStore.set(key, value);
        return "OK";
      },
      status: "ready"
    } as const;

    const breaker = new ChannelCircuitBreaker({
      now: () => now,
      redis: redis as never
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await breaker.recordHardFailure("chn_1", "provider_error");
      await expect(breaker.canRequest("chn_1")).resolves.toBe(true);
      now += 10_000;
    }

    await breaker.recordHardFailure("chn_1", "provider_error");
    await expect(breaker.canRequest("chn_1")).resolves.toBe(false);

    now += 120_001;
    await expect(breaker.canRequest("chn_1")).resolves.toBe(true);
  });

  it("fails over only before submit for mobile money or card, but always for SMS submit failures", async () => {
    const calls: string[] = [];

    const mobileMoneyResult = await executeWithFailover({
      allowFailoverOnAnySubmitFailure: false,
      channelIds: ["chn_primary", "chn_secondary"],
      executor: {
        async execute(channelId: string) {
          calls.push(channelId);
          if (channelId === "chn_primary") {
            throw Object.assign(new Error("Connection refused"), {
              code: "ECONNREFUSED"
            });
          }

          return "accepted";
        }
      }
    });

    expect(mobileMoneyResult).toBe("accepted");
    expect(calls).toEqual(["chn_primary", "chn_secondary"]);

    await expect(
      executeWithFailover({
        allowFailoverOnAnySubmitFailure: false,
        channelIds: ["chn_primary", "chn_secondary"],
        executor: {
          async execute(channelId: string) {
            if (channelId === "chn_primary") {
              throw Object.assign(new Error("Timed out"), {
                code: "ETIMEDOUT"
              });
            }

            return "should_not_happen";
          }
        }
      })
    ).rejects.toMatchObject({
      code: "provider_error"
    });

    const smsCalls: string[] = [];
    const smsResult = await executeWithFailover({
      allowFailoverOnAnySubmitFailure: true,
      channelIds: ["sms_primary", "sms_secondary"],
      executor: {
        async execute(channelId: string) {
          smsCalls.push(channelId);
          if (channelId === "sms_primary") {
            throw new Error("Submit failed");
          }

          return "sent";
        }
      }
    });

    expect(smsResult).toBe("sent");
    expect(smsCalls).toEqual(["sms_primary", "sms_secondary"]);
  });
});
