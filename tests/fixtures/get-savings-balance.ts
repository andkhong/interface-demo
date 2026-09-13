// A HAND-WRITTEN capability used by the replay tests. It proves the replay engine works
// before (and independently of) any AI discovery run.

import type { Capability } from "../../src/capability/schema";

export function getSavingsBalanceFixture(): Capability {
  return {
    schemaVersion: "capability/1",
    id: "cu-legacy.get-savings-balance-fixture",
    version: "1.0.0",
    title: "Get savings balance (hand-written test fixture)",
    description: "Look up a member by member number and return the current balance of their regular savings suffix (S00).",
    status: "draft",
    approval: null,
    contentHash: "",
    createdFrom: { kind: "hand-written", createdAt: "2026-09-12T00:00:00.000Z" },
    app: { profile: "cu-legacy", surface: "web", startPath: "/cu/main" },
    risk: "read_only",
    inputs: {
      memberId: { type: "string", description: "6-digit member number", pattern: "^\\d{6}$", sensitivity: "pii" },
    },
    outputs: {
      savingsBalance: { type: "money", description: "Current balance of the REGULAR SAVINGS suffix", sensitivity: "none" },
    },
    outcomes: [
      { code: "MEMBER_NOT_FOUND", description: "No member matches the member number given.", whenTextVisible: "NO RECORDS MATCH" },
    ],
    targets: {
      memberInquiryLink: {
        description: "Member Inquiry link in the menu",
        frame: "menu",
        locators: [
          { by: "role", role: "link", name: "Member Inquiry" },
          { by: "css", selector: 'a[href="/cu/inquiry"]' },
        ],
      },
      memberNumberBox: {
        description: "Member # box",
        frame: "main",
        locators: [
          { by: "rowLabel", role: "textbox", label: "Member #" },
          { by: "css", selector: 'input[name="fld_03"]' },
        ],
      },
      inquireButton: {
        description: "Inquire button",
        frame: "main",
        locators: [
          { by: "role", role: "button", name: "Inquire" },
          { by: "css", selector: 'input[name="btn_1"]' },
        ],
      },
      memberLink: {
        description: "Member number link in the inquiry results",
        frame: "main",
        locators: [
          { by: "role", role: "link", name: "{{inputs.memberId}}" },
          { by: "css", selector: 'a[href="/cu/member?m={{inputs.memberId}}"]' },
        ],
      },
      savingsBalanceCell: {
        description: "Current Bal of the REGULAR SAVINGS row",
        frame: "main",
        locators: [
          { by: "tableCell", row: "REGULAR SAVINGS", column: "Current Bal" },
          { by: "rowLabel", role: "cell", label: "S00" },
        ],
      },
    },
    steps: [
      {
        id: "openInquiry",
        intent: "Open Member Inquiry from the menu",
        do: { action: "click", target: "memberInquiryLink" },
        risk: "safe",
        by: "author",
        then: [{ type: "targetVisible", target: "memberNumberBox" }],
        timeoutMs: 10_000,
      },
      {
        id: "enterMember",
        intent: "Type the member number",
        do: { action: "fill", target: "memberNumberBox", value: "{{inputs.memberId}}" },
        risk: "safe",
        by: "author",
        then: [],
        timeoutMs: 10_000,
      },
      {
        id: "search",
        intent: "Run the inquiry",
        do: { action: "click", target: "inquireButton" },
        risk: "safe",
        by: "author",
        then: [{ type: "targetVisible", target: "memberLink" }],
        timeoutMs: 10_000,
      },
      {
        id: "openMember",
        intent: "Open the member's detail page",
        do: { action: "click", target: "memberLink" },
        risk: "safe",
        by: "author",
        then: [
          { type: "urlContains", value: "/cu/member" },
          { type: "targetVisible", target: "savingsBalanceCell" },
        ],
        timeoutMs: 10_000,
      },
      {
        id: "readBalance",
        intent: "Read the savings balance",
        do: { action: "extract", target: "savingsBalanceCell", output: "savingsBalance" },
        risk: "safe",
        by: "author",
        then: [],
        timeoutMs: 10_000,
      },
    ],
    finalCheck: [{ type: "outputPresent", output: "savingsBalance" }],
    reviewNotes: [],
  };
}
