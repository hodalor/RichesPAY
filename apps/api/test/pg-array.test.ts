import { describe, expect, it } from "vitest";

import { parsePgTextArray } from "../src/lib/pg-array";

describe("parsePgTextArray", () => {
  it("returns arrays unchanged", () => {
    expect(parsePgTextArray(["collections", "read"])).toEqual(["collections", "read"]);
  });

  it("parses postgres enum array text", () => {
    expect(parsePgTextArray("{collections,payouts,read}")).toEqual([
      "collections",
      "payouts",
      "read"
    ]);
  });

  it("parses quoted postgres array text", () => {
    expect(parsePgTextArray('{"collections","read"}')).toEqual(["collections", "read"]);
  });

  it("returns an empty array for empty input", () => {
    expect(parsePgTextArray("{}")).toEqual([]);
    expect(parsePgTextArray(null)).toEqual([]);
  });
});
