import { describe, expect, it } from "vitest";

import {
  MASKED_FIELD_VALUE,
  presentFieldValue,
} from "../../src/render/fieldPresentation";

describe("sensitive field presentation", () => {
  const sensitiveField = {
    sensitive: true,
    value: "correct horse battery staple",
  } as const;

  it("remasks a previously revealed value whenever the app locks", () => {
    expect(presentFieldValue(sensitiveField, true, false)).toEqual({
      masked: false,
      value: sensitiveField.value,
    });
    expect(presentFieldValue(sensitiveField, true, true)).toEqual({
      masked: true,
      value: MASKED_FIELD_VALUE,
    });
  });

  it("does not expose a sensitive value without an explicit reveal", () => {
    expect(presentFieldValue(sensitiveField, false, false)).toEqual({
      masked: true,
      value: MASKED_FIELD_VALUE,
    });
  });
});
