export const fiscalReportPeriodIds = ["thisFiscalQuarter", "lastFiscalQuarter", "nextFiscalQuarter", "fiscalQuarterToDate", "thisFiscalYear", "lastFiscalYear", "nextFiscalYear", "fiscalYearToDate"] as const;
export function isFiscalReportPeriod(period: string | undefined) {
  return fiscalReportPeriodIds.some(value => value === period);
}
// Shared UTC calendar arithmetic. Callers validate custom dates with their schemas.
export const reportPeriodIds = ["all", "today", "yesterday", "thisWeek", "last7", "last30", "thisMonth", "lastMonth", "thisQuarter", "thisYear", ...fiscalReportPeriodIds, "custom"] as const;
export type ReportPeriod = typeof reportPeriodIds[number];
export const reportPeriods: Record<ReportPeriod, string> = {
  all: "All dates", today: "Today", yesterday: "Yesterday", thisWeek: "This week (Mon–Sun)",
  last7: "Last 7 days", last30: "Last 30 days", thisMonth: "This month", lastMonth: "Last month",
  thisQuarter: "This quarter", thisYear: "This year",
  thisFiscalQuarter: "This fiscal quarter (UTC)", lastFiscalQuarter: "Last fiscal quarter (UTC)", nextFiscalQuarter: "Next fiscal quarter (UTC)", fiscalQuarterToDate: "This fiscal quarter so far (UTC)",
  thisFiscalYear: "This fiscal year (UTC)", lastFiscalYear: "Last fiscal year (UTC)", nextFiscalYear: "Next fiscal year (UTC)", fiscalYearToDate: "This fiscal year so far (UTC)", custom: "Custom range",
};
export function reportDateRange(f: {period:ReportPeriod;from?:string;to?:string}, now = new Date(), fiscalStartMonth?: number): { from: string; to: string } | null {
  if (f.period === "all") return null;
  if (f.period === "custom") return { from: f.from!, to: f.to! };
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const offset = (days: number) => new Date(date.getTime() + days * 86400000);
  const year = date.getUTCFullYear(), month = date.getUTCMonth();
  if (isFiscalReportPeriod(f.period)) {
    if (!Number.isInteger(fiscalStartMonth) || fiscalStartMonth! < 1 || fiscalStartMonth! > 12)
      throw Error("The workspace fiscal calendar is required to calculate this report.");
    const start = fiscalStartMonth! - 1;
    const fiscalYear = year - (month < start ? 1 : 0);
    const quarter = f.period.includes('Quarter');
    const length = quarter ? 3 : 12;
    const current = quarter ? start + Math.floor((month - start + 12) % 12 / 3) * 3 : start;
    const shift = f.period.startsWith('last') ? -length : f.period.startsWith('next') ? length : 0;
    const from = new Date(Date.UTC(fiscalYear, current + shift, 1));
    const to = f.period.endsWith('ToDate') ? date : new Date(Date.UTC(fiscalYear, current + shift + length, 0));
    return {from: iso(from), to: iso(to)};
  }
  let from = date, to = date;
  switch (f.period) {
    case "yesterday": from = to = offset(-1); break;
    case "last7": from = offset(-6); break;
    case "last30": from = offset(-29); break;
    case "thisWeek": from = offset(-((date.getUTCDay() + 6) % 7)); to = new Date(from.getTime() + 6 * 86400000); break;
    case "thisMonth": from = new Date(Date.UTC(year, month, 1)); to = new Date(Date.UTC(year, month + 1, 0)); break;
    case "lastMonth": from = new Date(Date.UTC(year, month - 1, 1)); to = new Date(Date.UTC(year, month, 0)); break;
    case "thisQuarter": from = new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1)); to = new Date(Date.UTC(year, Math.floor(month / 3) * 3 + 3, 0)); break;
    case "thisYear": from = new Date(Date.UTC(year, 0, 1)); to = new Date(Date.UTC(year + 1, 0, 0)); break;
  }
  return { from: iso(from), to: iso(to) };
}
