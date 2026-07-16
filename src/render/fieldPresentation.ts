import type { DisplayField } from "../analyzer";

export const MASKED_FIELD_VALUE = "••••••••";

export interface FieldPresentation {
  readonly masked: boolean;
  readonly value: string;
}

export function presentFieldValue(
  field: Pick<DisplayField, "sensitive" | "value">,
  revealRequested: boolean,
  locked: boolean,
): FieldPresentation {
  const revealed = field.sensitive && revealRequested && !locked;
  const masked = field.sensitive && !revealed;
  return {
    masked,
    value: masked ? MASKED_FIELD_VALUE : field.value,
  };
}

// Field labels appear mid-sentence in action text ("Copy destination host").
// Words holding consecutive capitals are acronyms ("QR", "(SSID)") and must
// keep their casing rather than being swept into the lowercase form.
export function fieldLabelForSentence(label: string): string {
  return label
    .split(" ")
    .map((word) => (/[A-Z]{2}/.test(word) ? word : word.toLowerCase()))
    .join(" ");
}
