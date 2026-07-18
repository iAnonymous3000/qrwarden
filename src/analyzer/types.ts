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

export type ReportFieldPolicy = "hidden" | "safe";

/**
 * A renderer may render only `value`, which is escaped and bounded inert text.
 * `actionValue` retains the exact analyzed field value for analyzer integrity
 * checks and must never be substituted into markup or another active sink.
 * `sensitive` and `masked` are display instructions; they never grant an action
 * capability. `reportPolicy` is fail-closed: a field reaches the copied report
 * only when its analyzer call site explicitly marks it `safe`. When
 * `reportValue` is present, every report consumer must use it instead of
 * `value`; falling back to the display value can re-export attacker-controlled
 * detail the analyzer deliberately replaced. Neither property changes the
 * on-screen display. Clipboard actions copy the escaped, bounded `value`, never
 * the exact `actionValue`.
 */
export interface DisplayField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly actionValue: string;
  readonly kind: DisplayFieldKind;
  readonly sensitive: boolean;
  readonly masked: boolean;
  readonly collapsed: boolean;
  readonly truncated: boolean;
  readonly count?: number;
  readonly omittedCount?: number;
  readonly reportPolicy: ReportFieldPolicy;
  readonly reportValue?: string;
}

export type AnalysisSignalCode =
  | "idn-hostname"
  | "trailing-dot-host"
  | "http"
  | "ip-address"
  | "local-or-special-destination"
  | "non-default-port"
  | "link-shortener"
  | "mixed-scripts"
  | "confusable-label"
  | "hidden-character"
  | "material-browser-rewrite"
  | "userinfo"
  | "forbidden-authority-character"
  | "malformed-web-url"
  | "assumed-iso-8859-1";

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
      // Opaque to the analyzer: only presence is meaningful here.
      readonly eci: NonNullable<unknown> | null;
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
