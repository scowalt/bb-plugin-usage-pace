import { describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk", () => {
  throw new Error("The browser's reset data module imported the backend SDK");
});

describe("browser-safe reset data", () => {
  it("constructs and validates unavailable inventory without the backend SDK", async () => {
    const { bankedResetsSchema, bankedResetsUnavailable } = await import("./banked-resets-contract");
    const inventory = bankedResetsUnavailable("Try again.");
    expect(inventory).toMatchObject({ status: "error", availableCount: null, credits: [] });
    expect(bankedResetsSchema.parse(inventory)).toEqual(inventory);
  });
});
