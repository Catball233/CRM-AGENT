/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { getBrowserStorage } from "./browser-storage";

describe("D-02 browser storage", () => {
  it("falls back to in-memory storage when localStorage operations are blocked", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    try {
      const storage = getBrowserStorage();
      storage.setItem("test-key", "test-value");
      expect(storage.getItem("test-key")).toBe("test-value");
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    }
  });
});
