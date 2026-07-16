export type SignalLevel = "context" | "review";

export type ActionPolicy = "open-web" | "confirm-web" | "inspect-only";

export type PayloadKind =
  | "web-url"
  | "wifi"
  | "otp"
  | "dpp"
  | "contact"
  | "calendar"
  | "email"
  | "sms"
  | "telephone"
  | "geo"
  | "payment"
  | "custom-uri"
  | "gs1"
  | "iso-15434"
  | "empty"
  | "text"
  | "binary";

export type DisplayFieldKind =
  | "text"
  | "hostname"
  | "domain"
  | "port"
  | "path"
  | "names"
  | "presence"
  | "count"
  | "hex";

/**
 * A renderer may render only these inert values as text. `sensitive` and
 * `masked` are display instructions; they never grant an action capability.
 */
export interface DisplayField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly kind: DisplayFieldKind;
  readonly sensitive: boolean;
  readonly masked: boolean;
  readonly collapsed: boolean;
  readonly truncated: boolean;
  readonly count?: number;
  readonly omittedCount?: number;
}

export type AnalysisSignalCode =
  | "idn-hostname"
  | "trailing-dot-host"
  | "http"
  | "ip-address"
  | "local-or-special-destination"
  | "non-default-port"
  | "mixed-scripts"
  | "confusable-label"
  | "hidden-character"
  | "material-browser-rewrite"
  | "userinfo"
  | "forbidden-authority-character"
  | "malformed-web-url";

export interface AnalysisSignal {
  readonly code: AnalysisSignalCode;
  readonly level: SignalLevel;
  readonly title: string;
  readonly detail: string;
}

export interface AnalysisReport {
  readonly schemaVersion: 1;
  readonly analyzerVersion: string;
  readonly kind: PayloadKind;
  readonly canonicalHref?: string;
  readonly displayFields: readonly DisplayField[];
  readonly signals: readonly AnalysisSignal[];
  readonly limitations: readonly string[];
  readonly actionPolicy: ActionPolicy;
}

export interface AnalyzerFrozenBytes {
  readonly byteLength: number;
  readonly hex: string;
}

export type AnalyzerTextDecoding =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly encoding: "utf-8" | "shift_jis" | "iso-8859-1";
      readonly eci: unknown | null;
    }
  | {
      readonly kind: "binary";
      readonly reason: string;
      readonly eci: null;
    };

/** Structural boundary implemented by decoder DecodeResult without coupling. */
export interface AnalyzerInput {
  readonly rawBytes: AnalyzerFrozenBytes;
  readonly contentType: string;
  readonly decoding: AnalyzerTextDecoding;
}

export interface AnalyzeTextInput {
  readonly text: string;
  readonly contentType?: string;
  readonly rawBytes?: AnalyzerFrozenBytes;
}
