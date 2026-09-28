import { describe, expect, it } from "vitest";

import {
  floatBalanceIsLow,
  queueBacklogThreshold,
  successRateDropped
} from "../src/observability/alerts";
import { scrubPii } from "../src/observability/pii";
import { recordHttpRequest, renderPrometheusMetrics } from "../src/observability/metrics";

describe("production observability", () => {
  it("scrubs payment secrets and contact details", () => {
    expect(
      scrubPii({
        card_number: "4242424242424242",
        email: "ada@example.com",
        note: "reach +233240000001 or ada@example.com",
        otp: "123456"
      })
    ).toEqual({
      card_number: "[redacted]",
      email: "[redacted]",
      note: "reach [redacted-phone] or [redacted-email]",
      otp: "[redacted]"
    });
  });

  it("flags a success-rate drop of 10 points across 15 minutes", () => {
    expect(
      successRateDropped({
        currentSuccesses: 80,
        currentTotal: 100,
        previousSuccesses: 95,
        previousTotal: 100
      })
    ).toBe(true);
    expect(
      successRateDropped({
        currentSuccesses: 2,
        currentTotal: 2,
        previousSuccesses: 2,
        previousTotal: 2
      })
    ).toBe(false);
  });

  it("treats a low provider float as an alert", () => {
    expect(floatBalanceIsLow(999n, 1000n)).toBe(true);
    expect(floatBalanceIsLow(null, 1000n)).toBe(false);
    expect(queueBacklogThreshold).toBe(1000);
  });

  it("exposes Prometheus request metrics", () => {
    recordHttpRequest({
      durationSeconds: 0.2,
      method: "GET",
      route: "/health",
      status: 200
    });

    const body = renderPrometheusMetrics();
    expect(body).toContain("richespay_http_requests_total");
    expect(body).toContain('route="/health"');
  });
});
