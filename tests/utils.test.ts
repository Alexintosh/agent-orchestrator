import { describe, it, expect } from "vitest";
import {
  parseObject,
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseJson,
  appendWithCap,
  MAX_CAPTURE_BYTES,
  MAX_EXCERPT_BYTES,
} from "../src/adapters/_shared/utils.js";

describe("parseObject", () => {
  it("returns the object as-is for a plain object", () => {
    const obj = { a: 1, b: "two" };
    expect(parseObject(obj)).toBe(obj);
  });

  it("returns empty object for null", () => {
    expect(parseObject(null)).toEqual({});
  });

  it("returns empty object for undefined", () => {
    expect(parseObject(undefined)).toEqual({});
  });

  it("returns empty object for array", () => {
    expect(parseObject([1, 2, 3])).toEqual({});
  });

  it("returns empty object for primitives", () => {
    expect(parseObject("string")).toEqual({});
    expect(parseObject(42)).toEqual({});
    expect(parseObject(true)).toEqual({});
  });
});

describe("asString", () => {
  it("returns the string if non-empty", () => {
    expect(asString("hello", "fallback")).toBe("hello");
  });

  it("returns fallback for empty string", () => {
    expect(asString("", "fallback")).toBe("fallback");
  });

  it("returns fallback for non-string types", () => {
    expect(asString(42, "fallback")).toBe("fallback");
    expect(asString(null, "fallback")).toBe("fallback");
    expect(asString(undefined, "fallback")).toBe("fallback");
    expect(asString(true, "fallback")).toBe("fallback");
  });
});

describe("asNumber", () => {
  it("returns the number for valid finite numbers", () => {
    expect(asNumber(42, 0)).toBe(42);
    expect(asNumber(-3.14, 0)).toBe(-3.14);
    expect(asNumber(0, 99)).toBe(0);
  });

  it("returns fallback for NaN", () => {
    expect(asNumber(NaN, 99)).toBe(99);
  });

  it("returns fallback for Infinity", () => {
    expect(asNumber(Infinity, 99)).toBe(99);
    expect(asNumber(-Infinity, 99)).toBe(99);
  });

  it("returns fallback for non-number types", () => {
    expect(asNumber("42", 99)).toBe(99);
    expect(asNumber(null, 99)).toBe(99);
    expect(asNumber(undefined, 99)).toBe(99);
  });
});

describe("asBoolean", () => {
  it("returns the boolean value", () => {
    expect(asBoolean(true, false)).toBe(true);
    expect(asBoolean(false, true)).toBe(false);
  });

  it("returns fallback for non-boolean types", () => {
    expect(asBoolean("true", false)).toBe(false);
    expect(asBoolean(1, false)).toBe(false);
    expect(asBoolean(null, true)).toBe(true);
  });
});

describe("asStringArray", () => {
  it("filters to only strings", () => {
    expect(asStringArray(["a", 1, "b", null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for non-array input", () => {
    expect(asStringArray("not an array")).toEqual([]);
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray(42)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(asStringArray([])).toEqual([]);
  });
});

describe("parseJson", () => {
  it("parses valid JSON", () => {
    expect(parseJson('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseJson("not json")).toBeNull();
    expect(parseJson("{broken")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseJson("")).toBeNull();
  });
});

describe("appendWithCap", () => {
  it("concatenates within cap", () => {
    expect(appendWithCap("hello", " world", 100)).toBe("hello world");
  });

  it("truncates from the beginning when exceeding cap", () => {
    const result = appendWithCap("abcde", "fghij", 8);
    expect(result).toBe("cdefghij");
    expect(result.length).toBe(8);
  });

  it("handles empty strings", () => {
    expect(appendWithCap("", "hello", 100)).toBe("hello");
    expect(appendWithCap("hello", "", 100)).toBe("hello");
  });
});

describe("constants", () => {
  it("MAX_CAPTURE_BYTES is 4MB", () => {
    expect(MAX_CAPTURE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("MAX_EXCERPT_BYTES is 32KB", () => {
    expect(MAX_EXCERPT_BYTES).toBe(32 * 1024);
  });
});
