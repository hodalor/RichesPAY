import { describe, expect, it } from "vitest";

import { formatMoney, fromMinor, toMinor } from "../src/money";

describe("money helpers", () => {
  it("converts decimal strings into minor units", () => {
    expect(toMinor("15.00", "GHS")).toBe(1500n);
    expect(toMinor("7", "USD")).toBe(700n);
    expect(toMinor("-1.25", "ZMW")).toBe(-125n);
  });

  it("converts minor units back into strings", () => {
    expect(fromMinor(1500n, "GHS")).toBe("15.00");
    expect(fromMinor(5n, "USD")).toBe("0.05");
  });

  it("formats money with Intl", () => {
    expect(formatMoney(1500n, "GHS", "en-GH")).toContain("15.00");
    expect(formatMoney(123456n, "USD", "en-US")).toContain("1,234.56");
  });

  it("rejects too many fractional digits", () => {
    expect(() => toMinor("1.999", "GHS")).toThrow(
      /Too many fractional digits/
    );
  });
});
