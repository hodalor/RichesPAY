import { describe, expect, it } from "vitest";

import { newId } from "../src/ids";

describe("newId", () => {
  it("creates a prefixed ULID", () => {
    const value = newId("col_");

    expect(value).toMatch(/^col_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("normalizes missing underscores", () => {
    const value = newId("pay");

    expect(value).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
