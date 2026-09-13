# Look up member savings balance

`cu-legacy.get-savings-balance@1.0.0` · status **approved** · risk **read_only** · app `cu-legacy`

Given a member number, opens Member Inquiry, looks up the member, and returns the current balance of their regular savings (S00) suffix.

Approved by Demo Reviewer (evidence script) at 2026-09-13T05:37:22.079Z (stability 10/10 succeeded, 10/10 returned MEMBER_NOT_FOUND).

Created from: discovery run `discovery_2026-09-12_22-36-24_acct` with `claude-opus-5`.

## Inputs

| Name | Type | Rule | Sensitivity | Description |
|---|---|---|---|---|
| `memberNumber` | string | `^\d{6}$` | pii | Member number to look up |

## Outputs

| Name | Type | Sensitivity | Description |
|---|---|---|---|
| `savingsBalance` | money | none | Current balance of the member's regular savings (S00) account |

## Business outcomes (not errors)

- `MEMBER_NOT_FOUND` when "NO RECORDS MATCH" is shown: No member matches the member number given.
- `VALIDATION_REJECTED` when "INVALID MEMBER # FORMAT" is shown: The app rejected the member number format.

## Steps

1. **Open Member Inquiry from the menu** — click "link "Member Inquiry""
   - find it by: role `link` named "Member Inquiry" → css `a[href="/cu/inquiry"]` (frame `menu`)
   - then check: a frame URL contains "/cu/inquiry"; "text box in the row labelled "Member #"" is visible
2. **Enter the member number to look up** — fill "text box in the row labelled "Member #"" with `{{inputs.memberNumber}}`
   - find it by: `textbox` in the row labelled "Member #" → css `input[name="fld_03"]` (frame `main`)
   - then check: "button "Inquire"" is visible
3. **Submit the member inquiry** — click "button "Inquire""
   - find it by: role `button` named "Inquire" → css `input[name="btn_1"]` (frame `main`)
   - then check: a frame URL contains "/cu/inquiry/results"; "link "{{inputs.memberNumber}}"" is visible
4. **Open the member's account detail from the results list** — click "link "{{inputs.memberNumber}}""
   - find it by: role `link` named "{{inputs.memberNumber}}" → css `a[href="/cu/member?m={{inputs.memberNumber}}"]` (frame `main`)
   - then check: a frame URL contains "/cu/member"; ""Current Bal" cell in the "REGULAR SAVINGS" row" is visible
5. **Read the current balance of the regular savings suffix** — extract ""Current Bal" cell in the "REGULAR SAVINGS" row" into output `savingsBalance`
   - find it by: cell in column "Current Bal", row "REGULAR SAVINGS" → cell in column "Current Bal", row "S00" (frame `main`)

## Final check

- text "SHARE / LOAN SUFFIXES" is visible
- output `savingsBalance` was read
