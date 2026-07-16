import { describe, expect, it } from "vitest";

import { analyzeText } from "../../src/analyzer";
import { matchLinkShortener } from "../../src/analyzer/linkShorteners";

describe("link shortener matching", () => {
  it("matches exact hosts, subdomains, trailing dots, and mixed case", () => {
    expect(matchLinkShortener("bit.ly")).toBe("bit.ly");
    expect(matchLinkShortener("www.bit.ly")).toBe("bit.ly");
    expect(matchLinkShortener("BIT.LY.")).toBe("bit.ly");
    expect(matchLinkShortener("tinyurl.com")).toBe("tinyurl.com");
  });

  it("never matches lookalike or unrelated hosts", () => {
    expect(matchLinkShortener("bit.ly.example.com")).toBeNull();
    expect(matchLinkShortener("notbit.ly")).toBeNull();
    expect(matchLinkShortener("example.com")).toBeNull();
    expect(matchLinkShortener("")).toBeNull();
  });

  it("raises a review signal that names the service and requires confirmation", () => {
    const report = analyzeText("https://t.co/AbCdEf");
    const shortener = report.signals.find((item) => item.code === "link-shortener");
    expect(shortener?.level).toBe("review");
    expect(shortener?.detail).toContain("t.co");
    expect(report.actionPolicy).toBe("confirm-web");
  });

  it("does not classify IP destinations as shorteners", () => {
    const report = analyzeText("http://127.0.0.1/abc");
    expect(report.signals.some((item) => item.code === "link-shortener")).toBe(false);
  });
});
