import { revenueTotals, type LineItem } from "./commerce";

export const dealRevenueFields = [
  { id: "totalContractValue", label: "Total contract value (USD)" },
  { id: "annualContractValue", label: "Annual contract value (USD)" },
  { id: "annualRecurringRevenue", label: "Annual recurring revenue (USD)" },
  { id: "monthlyRecurringRevenue", label: "Monthly recurring revenue (USD)" },
] as const;
export type DealRevenueField = typeof dealRevenueFields[number]["id"];
export type DealRevenue = Record<DealRevenueField, number>;
export function isDealRevenueField(field: string): field is DealRevenueField {
  return dealRevenueFields.some(f => f.id === field);
}
export function dealRevenue(items: LineItem[]): DealRevenue {
  const totals = revenueTotals(items);
  return { totalContractValue: totals.tcvCents / 100, annualContractValue: totals.acvCents / 100,
    annualRecurringRevenue: totals.arrCents / 100, monthlyRecurringRevenue: totals.mrrCents / 100 };
}

// Parsing editable data intentionally strips calculated keys. Restore them only
// from the server's previous row, or the line-item transaction's computed result.
export function retainDealRevenue<T extends object>(data: T, previous?: Partial<DealRevenue>, calculated?: DealRevenue): T & Partial<DealRevenue> {
  const result = { ...data } as T & Partial<DealRevenue>;
  for (const { id } of dealRevenueFields) {
    delete result[id];
    const value = (calculated ?? previous)?.[id];
    if (value !== undefined) result[id] = value;
  }
  return result;
}
