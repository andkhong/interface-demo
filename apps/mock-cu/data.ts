// Synthetic data for the fake credit-union app.
// Every name, SSN (900-series, never issued), address and phone number here is invented.

export interface Suffix {
  sfx: string; // share/loan "suffix" code, e.g. S00 = regular savings
  description: string;
  balance: number;
  available: number | null; // null for loans
}

export interface Member {
  memberNumber: string;
  name: string;
  ssn: string;
  birthDate: string;
  address: string;
  phone: string;
  branch: string;
  status: string;
  suffixes: Suffix[];
}

export const PRODUCTS = [
  { code: "S20", description: "HOLIDAY CLUB" },
  { code: "S30", description: "MONEY MARKET" },
  { code: "C12", description: "12 MONTH CERTIFICATE" },
] as const;

// Deposits above this amount need a supervisor, so the app answers "NOT AUTHORIZED".
export const TELLER_LIMIT = 5000;

export function seedMembers(): Map<string, Member> {
  const members: Member[] = [
    {
      memberNumber: "100234",
      name: "DELGADO, ROSA M",
      ssn: "900-55-1234",
      birthDate: "04/17/1968",
      address: "1420 W ELM ST, SPRINGFIELD IL 62704",
      phone: "(217) 555-0142",
      branch: "004",
      status: "ACTIVE",
      suffixes: [
        { sfx: "S00", description: "REGULAR SAVINGS", balance: 1523.4, available: 1498.4 },
        { sfx: "S10", description: "SHARE DRAFT CHECKING", balance: 842.17, available: 842.17 },
        { sfx: "L40", description: "AUTO LOAN", balance: 12345.0, available: null },
      ],
    },
    {
      memberNumber: "100587",
      name: "PARK, JONATHAN K",
      ssn: "900-71-8842",
      birthDate: "11/02/1985",
      address: "88 LAKEVIEW DR APT 3, DECATUR IL 62521",
      phone: "(217) 555-0199",
      branch: "004",
      status: "ACTIVE",
      suffixes: [
        { sfx: "S00", description: "REGULAR SAVINGS", balance: 8210.95, available: 8185.95 },
        { sfx: "S10", description: "SHARE DRAFT CHECKING", balance: 2301.55, available: 2301.55 },
      ],
    },
    {
      memberNumber: "102219",
      name: "DELGADO, MARCUS T",
      ssn: "900-23-4410",
      birthDate: "07/29/1991",
      address: "1420 W ELM ST, SPRINGFIELD IL 62704",
      phone: "(217) 555-0177",
      branch: "011",
      status: "ACTIVE",
      suffixes: [{ sfx: "S00", description: "REGULAR SAVINGS", balance: 310.0, available: 285.0 }],
    },
  ];
  return new Map(members.map((m) => [m.memberNumber, m]));
}

export function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
