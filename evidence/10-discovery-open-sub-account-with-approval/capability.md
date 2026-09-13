# Open a new sub-account with an opening deposit

`cu-legacy.open-sub-account@1.0.0` · status **draft** · risk **irreversible** · app `cu-legacy`

Opens a new sub-account for a given member number, selecting the product, opening deposit amount, and funding account, then returns the confirmation number from the confirmation screen.

Created from: discovery run `discovery_2026-09-12_22-37-45_qajv` with `claude-opus-5`.

## Inputs

| Name | Type | Rule | Sensitivity | Description |
|---|---|---|---|---|
| `memberId` | string | `^\d{6}$` | pii | Member number to open the sub-account for |
| `product` | enum | "S20 - HOLIDAY CLUB", "S30 - MONEY MARKET", "C12 - 12 MONTH CERTIFICATE" | none | Sub-account product to open |
| `openingDeposit` | string | `^\d+(\.\d{2})?$` | none | Opening deposit amount for the new sub-account |
| `fundFromSuffix` | enum | "S00 - REGULAR SAVINGS", "S10 - SHARE DRAFT CHECKING" | none | Sub-account the opening deposit is funded from |

## Outputs

| Name | Type | Sensitivity | Description |
|---|---|---|---|
| `confirmationNumber` | string | none | Confirmation number of the sub-account opening |

## Business outcomes (not errors)

- `MEMBER_NOT_FOUND` when "NO RECORDS MATCH" is shown: No member matches the member number given.
- `VALIDATION_REJECTED` when "INVALID MEMBER # FORMAT" is shown: The app rejected the member number format.
- `VALIDATION_REJECTED` when "INVALID AMOUNT" is shown: The app rejected the deposit amount.
- `INSUFFICIENT_FUNDS` when "INSUFFICIENT AVAILABLE BALANCE" is shown: The funding suffix does not have enough available balance.
- `PERMISSION_DENIED` when "NOT AUTHORIZED" is shown: The teller is not authorized for this amount; a supervisor override is needed.

## Steps

1. **Open Member Inquiry from the menu** — click "link "Member Inquiry""
   - find it by: role `link` named "Member Inquiry" → css `a[href="/cu/inquiry"]` (frame `menu`)
   - then check: a frame URL contains "/cu/inquiry"; "text box in the row labelled "Member #"" is visible
2. **Enter the member number to look up** — fill "text box in the row labelled "Member #"" with `{{inputs.memberId}}`
   - find it by: `textbox` in the row labelled "Member #" → css `input[name="fld_03"]` (frame `main`)
   - then check: "button "Inquire"" is visible
3. **Look up the member record** — click "button "Inquire""
   - find it by: role `button` named "Inquire" → css `input[name="btn_1"]` (frame `main`)
   - then check: a frame URL contains "/cu/inquiry/results"; "link "{{inputs.memberId}}"" is visible
4. **Open the member's account detail** — click "link "{{inputs.memberId}}""
   - find it by: role `link` named "{{inputs.memberId}}" → css `a[href="/cu/member?m={{inputs.memberId}}"]` (frame `main`)
   - then check: a frame URL contains "/cu/member"; "button "Open Sub-Account"" is visible
5. **Open the sub-account creation screen** — click "button "Open Sub-Account""
   - find it by: role `button` named "Open Sub-Account" → css `input[name="btn_5"]` (frame `main`)
   - then check: a frame URL contains "/cu/subacct/new"; "dropdown in the row labelled "Product"" is visible
6. **Choose the sub-account product** — select "dropdown in the row labelled "Product"" option `{{inputs.product}}`
   - find it by: `combobox` in the row labelled "Product" → css `select[name="fld_11"]` (frame `main`)
   - then check: "text box in the row labelled "Opening Deposit"" is visible
7. **Enter the opening deposit amount** — fill "text box in the row labelled "Opening Deposit"" with `{{inputs.openingDeposit}}`
   - find it by: `textbox` in the row labelled "Opening Deposit" → css `input[name="fld_12"]` (frame `main`)
   - then check: "dropdown in the row labelled "Fund From Sfx"" is visible
8. **Choose the funding sub-account** — select "dropdown in the row labelled "Fund From Sfx"" option `{{inputs.fundFromSuffix}}`
   - find it by: `combobox` in the row labelled "Fund From Sfx" → css `select[name="fld_13"]` (frame `main`)
   - then check: "button "Continue"" is visible
9. **Continue to the confirmation step of opening the sub-account** — click "button "Continue""
   - find it by: role `button` named "Continue" → css `input[name="btn_2"]` (frame `main`)
   - then check: a frame URL contains "/cu/subacct/review"; "button "Confirm"" is visible
10. **Confirm opening the new sub-account and transferring funds** — click "button "Confirm"" · ⚠️ IRREVERSIBLE (needs human approval)
   - find it by: role `button` named "Confirm" → css `input[name="btn_3"]` (frame `main`)
   - then check: a frame URL contains "/cu/subacct/confirm"; "cell in the row labelled "Confirmation #"" is visible
11. **Read the confirmation number for the newly opened sub-account** — extract "cell in the row labelled "Confirmation #"" into output `confirmationNumber`
   - find it by: `cell` in the row labelled "Confirmation #" (frame `main`)

## Final check

- text "SUB-ACCOUNT OPENED" is visible
- output `confirmationNumber` was read
