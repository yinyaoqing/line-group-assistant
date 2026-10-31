import { describe, expect, it } from "vitest";
import { PLANS } from "../config/plans";
import { privacyHtml, termsHtml } from "../src/legal";
import { siteHtml } from "../src/site";

describe("legal pages", () => {
  it("the privacy policy says what the code does with messages and data", () => {
    const html = privacyHtml();
    expect(html).toContain("每一則文字訊息");
    expect(html).toContain("不保存");
    expect(html).toContain("Cloudflare D1");
    expect(html).toContain("不會自動刪除");
    expect(html).toContain("Anthropic Claude");
    expect(html).toContain('href="/terms"');
  });

  it("the terms quote the current prices and warn about relying on translations", () => {
    const html = termsHtml();
    expect(html).toContain(`NT$${PLANS.pro.price}`);
    expect(html).toContain("當面確認");
    expect(html).toContain('href="/privacy"');
  });

  it("the product site links to both and no longer claims nothing is stored", () => {
    const html = siteHtml("https://bot.example");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).not.toContain("只保存任務、工具材料、報表等你們主動建立的資料");
  });
});
