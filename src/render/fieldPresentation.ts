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
