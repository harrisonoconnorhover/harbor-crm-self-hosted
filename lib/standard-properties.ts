import { z } from "zod";
import type { Kind } from "./crm";
import type { Property } from "./workspace";

export type StandardProperty = {
  id: string;
  label: string;
  type: "text" | "number" | "select" | "checkbox";
  group: string;
  description: string;
  options?: readonly string[];
  inputType?: "url" | "tel";
  multiline?: boolean;
  optional: true;
  schema: z.ZodTypeAny;
};
const text = (id: string, label: string, group: string, description: string, max = 160): StandardProperty =>
  ({ id, label, group, description, type: "text", optional: true, schema: z.string().trim().max(max).optional() });
const longText = (id: string, label: string, group: string, description: string): StandardProperty =>
  ({ ...text(id, label, group, description, 2000), multiline: true });
const number = (id: string, label: string, group: string, description: string, max: number, integer = false): StandardProperty =>
  ({ id, label, group, description, type: "number", optional: true, schema: z.preprocess(v => v === "" || v === null ? undefined : v,
    (integer ? z.number().int() : z.number()).finite().min(0).max(max).optional()) });
const select = (id: string, label: string, group: string, description: string, options: readonly [string, ...string[]]): StandardProperty =>
  ({ id, label, group, description, type: "select", optional: true, options, schema: z.union([z.literal(""), z.enum(options)]).optional() });
const phone = (id: string, label: string): StandardProperty =>
  ({ ...text(id, label, "Contact information", "Include the country code when available.", 60), inputType: "tel" });
const url = (id: string, label: string, group: string): StandardProperty => ({
  ...text(id, label, group, "A full http:// or https:// URL, without login details.", 2048), inputType: "url",
  schema: z.string().trim().max(2048).refine(value => {
    if (!value) return true;
    try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; }
    catch { return false; }
  }, "Use a full http:// or https:// URL without login details.").optional(),
});
const address = [
  text("address", "Street address", "Address", "Street and building information.", 255),
  text("address2", "Street address 2", "Address", "Apartment, suite or additional address information.", 255),
  text("state", "State/Region", "Address", "State, province or region."),
  text("postalCode", "Postal code", "Address", "Stored as text to preserve leading zeros.", 40),
  text("country", "Country/Region", "Address", "Country or region name."),
];
const leadStatus = select("leadStatus", "Lead status", "Qualification", "Your current sales follow-up status; separate from lifecycle stage.",
  ["New", "Open", "In progress", "Open deal", "Unqualified", "Attempted to contact", "Connected", "Bad timing"]);
const timeZone = text("timeZone", "Time zone", "Contact information", "Time zone for planning outreach, for example America/New_York.", 100);

// These additions share validation and metadata across editing, imports and discovery.
// Empty optional numeric/boolean fields stay unknown, rather than becoming zero/false.
export const defaultForecastCategories = ["Not forecasted", "Pipeline", "Best case", "Most likely", "Commit", "Closed won"] as const;
export const standardExtensions: Record<Kind, StandardProperty[]> = {
  leads: [
    select("leadType", "Lead type", "Lead information", "The kind of sales pursuit.", ["New business", "Existing business"]),
    select("leadLabel", "Lead label", "Lead information", "Your assessment of this lead's interest.", ["Hot", "Warm", "Cold"]),
    longText("description", "Lead description", "Lead information", "Context for this sales pursuit."),
    select("disqualificationCategory", "Disqualification reason", "Lead information", "A consistent reason for ending this pursuit; used by follow-up automation.", ["Bad timing", "Not a fit", "Unable to reach", "Duplicate", "Other"]),
    longText("disqualificationReason", "Disqualification notes", "Lead information", "The explanation for ending this pursuit. Existing free-text reasons are preserved here."),
  ],
  contacts: [
    text("firstName", "First name", "Contact information", "Given name. Full name remains the record's display name."),
    text("lastName", "Last name", "Contact information", "Family name. Full name remains the record's display name."),
    phone("mobilePhone", "Mobile phone number"),
    url("website", "Website URL", "Contact information"),
    url("linkedinUrl", "LinkedIn URL", "Contact information"),
    text("department", "Department", "Professional information", "Department or business function."),
    text("seniority", "Seniority", "Professional information", "Role level, such as manager, director or executive."),
    leadStatus,
    text("preferredLanguage", "Preferred language", "Contact information", "Preferred language for conversations.", 80),
    timeZone,
    text("city", "City", "Address", "City or locality.", 120),
    ...address,
    longText("description", "Description", "Professional information", "Background and relationship context. Log dated interactions as activities."),
  ],
  companies: [
    phone("phone", "Phone number"), ...address, timeZone,
    number("numberOfEmployees", "Number of employees", "Company profile", "Known or estimated headcount; leave blank when unknown.", 1e9, true),
    number("annualRevenue", "Annual revenue (USD)", "Company profile", "Known or estimated annual revenue in USD; no currency conversion is performed.", 1e15),
    { ...number("yearFounded", "Year founded", "Company profile", "The four-digit founding year.", 9999, true),
      schema: z.preprocess(v => v === "" || v === null ? undefined : v, z.number().int().min(1000).max(9999).optional()) },
    select("companyType", "Company type", "Company profile", "How this company relates to your business.", ["Prospect", "Partner", "Reseller", "Vendor", "Other"]),
    longText("description", "Description", "Company profile", "What the company does and why it matters to your business."),
    url("linkedinUrl", "LinkedIn URL", "Company profile"), leadStatus,
    { id: "targetAccount", label: "Target account", group: "Qualification", description: "Whether this company is part of your target-account list.", type: "checkbox", optional: true,
      schema: z.preprocess(v => v === "" || v === null ? undefined : v, z.boolean().optional()) },
    select("icpTier", "Ideal customer profile tier", "Qualification", "Your assessment of fit; Tier 1 is the strongest fit.", ["Tier 1", "Tier 2", "Tier 3"]),
  ],
  deals: [
    select("forecastCategory", "Forecast category", "Forecasting", "Your assessment of closing confidence, set manually or by enabled pipeline stage mappings. Changing this does not change deal stage or probability.", defaultForecastCategories),
    longText("description", "Deal description", "Deal information", "Scope and context for this opportunity."),
    select("dealType", "Deal type", "Deal information", "Whether this opportunity is new or existing business.", ["New business", "Existing business"]),
    select("priority", "Priority", "Deal information", "Relative urgency for working this opportunity.", ["Low", "Medium", "High"]),
    longText("nextStep", "Next step", "Deal information", "The next agreed action. Use a task for a due date and completion tracking."),
    longText("closedWonReason", "Closed won reason", "Deal outcome", "Why the opportunity was won; entered manually."),
    longText("closedLostReason", "Closed lost reason", "Deal outcome", "Why the opportunity was lost; entered manually."),
  ],
  tickets: [
    longText("description", "Ticket description", "Ticket information", "Describe the issue and the desired resolution."),
    select("ticketSource", "Source", "Ticket information", "How this support request arrived; logging a source does not connect an inbox.", ["Email", "Phone", "Chat", "Form", "Other"]),
    select("ticketCategory", "Category", "Ticket information", "The area this request concerns.", ["Technical", "Billing", "Product question", "Other"]),
  ],
  tasks: [longText("notes", "Task notes", "Task details", "Instructions and context for completing this task.")],
};
const fieldSchemas = (kind: Kind) => Object.fromEntries(standardExtensions[kind].map(field => [field.id, field.schema]));
export const extensionSchemas = {
  contacts: fieldSchemas("contacts"),
  companies: fieldSchemas("companies"),
  deals: fieldSchemas("deals"),
  tasks: fieldSchemas("tasks"),
  tickets: fieldSchemas("tickets"),
  leads: fieldSchemas("leads"),
} satisfies Record<Kind, z.ZodRawShape>;
export function standardFields(kind: Kind, properties: Property[] = []) {
  return standardExtensions[kind].map(({ schema: _schema, ...field }) => {
    const configured = properties.find(p => p.kind === kind && p.standardField === field.id);
    return field.type === "select" && configured ? { ...field, options: configured.options } : field;
  });
}
export function standardField(kind: Kind, id: string, properties: Property[] = []) { return standardFields(kind, properties).find(f => f.id === id); }
export function standardOptionSchemas(kind: Kind, properties: Property[]): z.ZodRawShape {
  return Object.fromEntries(standardFields(kind, properties).filter(f => f.type === "select").map(f => [f.id,
    z.string().refine(v => v === "" || !!f.options?.includes(v), `Choose an available option for ${f.label}.`).optional()]));
}
export type StandardData = Partial<Record<
  "leadType" | "leadLabel" | "disqualificationCategory" | "disqualificationReason" | "firstName" | "lastName" | "mobilePhone" | "linkedinUrl" | "department" | "seniority" | "leadStatus" | "preferredLanguage" | "timeZone" |
  "address" | "address2" | "state" | "postalCode" | "country" | "description" | "companyType" | "icpTier" | "forecastCategory" | "dealType" | "nextStep" | "closedWonReason" | "closedLostReason" | "notes" | "ticketSource" | "ticketCategory", string>> & {
  numberOfEmployees?: number; annualRevenue?: number; yearFounded?: number; targetAccount?: boolean;
};
