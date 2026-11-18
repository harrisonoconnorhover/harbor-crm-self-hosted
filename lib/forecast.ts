import { stagePropertyItemsSchema, stagePropertyRulesSchema, validateStagePropertyRules, preserveStageRuleConditions, type StagePropertyRules } from "./stage-property-rules";
import { z } from "zod";
import { stageColorsSchema, type StageColors } from "./stage-colors";
import { stages, type CRMRecord, type Data } from "./crm";
export type Stage = (typeof stages)[number];
export type Probabilities = Record<string, number>;
export type StageOutcome = "open" | "won" | "lost";
export type StageOutcomes = Record<string, StageOutcome>;
export const stagePropertiesSchema = z.record(z.string(), stagePropertyItemsSchema);
export type StageProperties = z.infer<typeof stagePropertiesSchema>;
export const stageOutcomesSchema = z.record(z.string(), z.enum(["open", "won", "lost"]));
export function legacyStageOutcome(id: string): StageOutcome {
  return id === "Closed won" ? "won" : id === "Closed lost" ? "lost" : "open";
}
export const defaultProbabilities: Probabilities = {
  "Appointment scheduled": 20,
  "Qualified to buy": 40,
  "Presentation scheduled": 60,
  "Decision maker bought-in": 80,
  "Contract sent": 90,
  "Closed won": 100,
  "Closed lost": 0,
};
export const probabilitiesSchema = z
  .record(z.enum(stages), z.number().int().min(0).max(100))
  .superRefine((value, ctx) => {
    if (
      stages.some((stage) => value[stage] === undefined) ||
      value["Closed won"] !== 100 ||
      value["Closed lost"] !== 0
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Provide every stage. Closed won must be 100% and Closed lost must be 0%.",
      });
  })
  .transform((value) => value as Probabilities);
export const stageOrderSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(
        (name) => !["__proto__", "constructor", "prototype"].includes(name),
        "Choose another stage name.",
      ),
  )
  .min(3)
  .max(50)
  .superRefine((order, ctx) => {
    if (
      new Set(order.map((s) => s.toLowerCase())).size !== order.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Use unique stage identifiers.",
      });
  });
export const stageLabelsSchema = z.record(z.string(), z.string().trim().min(1).max(80));
export const forecastMappingSchema = z.object({enabled:z.boolean(),stages:z.record(z.string(), z.string().trim().min(1).max(80))}).strict();
export type ForecastMapping = z.infer<typeof forecastMappingSchema>;
export const pipelineInput = z.object({
  forecastMapping: forecastMappingSchema.optional(),
  stageColors: stageColorsSchema.optional(),
  stageProperties: stagePropertiesSchema.optional(),
  stagePropertyRules: stagePropertyRulesSchema.optional(),
  stageOutcomes: stageOutcomesSchema.optional(),
  removeStages: z.array(z.string().min(1).max(80)).max(48).optional(),
  stageLabels: stageLabelsSchema.optional(),
  pipelineId: z.string().max(100).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  revision: z.number().int().min(0),
  stageOrder: stageOrderSchema.optional(),
  probabilities: z.record(z.string(), z.number().int().min(0).max(100)),
});
export function validatePipeline(
  input: z.infer<typeof pipelineInput>,
  current: PipelineSettings,
) {
  const stageOrder = stageOrderSchema.parse(
    input.stageOrder ?? current.stageOrder,
  );
  const removed = current.stageOrder.filter((s) => !stageOrder.includes(s));
  const requested = new Set(input.removeStages ?? []);
  if (
    removed.some((s) => !requested.has(s)) ||
    [...requested].some((s) => !removed.includes(s))
  )
    throw new Error("Review each stage's usage before removing it.");
  const suppliedOutcomes = input.stageOutcomes ?? {};
  if (Object.keys(suppliedOutcomes).some(id => !stageOrder.includes(id) && !removed.includes(id)))
    throw new Error("Stage outcomes must belong to this pipeline.");
  const stageOutcomes = Object.fromEntries(stageOrder.map(id => [id,
    suppliedOutcomes[id] ?? current.stageOutcomes?.[id] ?? legacyStageOutcome(id),
  ])) as StageOutcomes;
  if (stageOutcomes[stageOrder[0]] !== "open" ||
      !stageOrder.some(id => stageOutcomes[id] === "won") ||
      !stageOrder.some(id => stageOutcomes[id] === "lost"))
    throw new Error("Start with an open stage and include at least one Won and one Lost outcome.");
  if (Object.keys(input.probabilities).length !== stageOrder.length ||
      stageOrder.some(id => !Object.hasOwn(input.probabilities, id) ||
        (stageOutcomes[id] === "won" && input.probabilities[id] !== 100) ||
        (stageOutcomes[id] === "lost" && input.probabilities[id] !== 0)))
    throw new Error("Provide a whole percentage for every stage. Won outcomes must be 100%; Lost outcomes must be 0%.");
  const stageLabels = input.stageLabels ?? current.stageLabels ?? {};
  if (Object.keys(stageLabels).some((id) => !stageOrder.includes(id)))
    throw new Error("Stage labels must belong to this pipeline.");
  const names = stageOrder.map((id) => (stageLabels[id] ?? id).toLowerCase());
  if (new Set(names).size !== names.length)
    throw new Error("Use a unique name for each stage in this pipeline.");
  const suppliedProperties = input.stageProperties ?? current.stageProperties ?? {};
  if (Object.keys(suppliedProperties).some(id => !stageOrder.includes(id) && !removed.includes(id)))
    throw new Error("Conditional properties must belong to this pipeline.");
  const stageProperties = Object.fromEntries(stageOrder.filter(id => suppliedProperties[id]?.length).map(id => [id, suppliedProperties[id]]));
  const suppliedColors = input.stageColors ?? current.stageColors ?? {};
  if (Object.keys(suppliedColors).some(id => !stageOrder.includes(id) && !removed.includes(id)))
    throw new Error("Stage colors must belong to this pipeline.");
  const stageColors = Object.fromEntries(stageOrder.filter(id => suppliedColors[id]).map(id => [id, suppliedColors[id]]));
  const stagePropertyRules = preserveStageRuleConditions(input.stagePropertyRules ?? current.stagePropertyRules ?? [],current.stagePropertyRules);
  validateStagePropertyRules({ stageOrder, stageProperties, stagePropertyRules });
  const suppliedMapping = input.forecastMapping ?? current.forecastMapping;
  if(suppliedMapping && Object.keys(suppliedMapping.stages).some(id=>!stageOrder.includes(id)&&!removed.includes(id)))
    throw new Error("Forecast category mappings must belong to this pipeline.");
  const forecastMapping = suppliedMapping ? {...suppliedMapping,stages:Object.fromEntries(stageOrder.filter(id=>Object.hasOwn(suppliedMapping.stages,id)).map(id=>[id,suppliedMapping.stages[id]]))} : undefined;
  if(forecastMapping?.enabled&&!Object.keys(forecastMapping.stages).length)throw new Error("Choose at least one stage category before enabling automatic categories.");
  return { ...input, stageOrder, stageLabels, stageOutcomes, stageProperties, stagePropertyRules, stageColors, ...(forecastMapping?{forecastMapping}:{}) };
}
export function storedPipeline(row?: {
  leadPipelines?: import("./lead-pipelines").LeadPipeline[] | null;
  probabilities: Probabilities;
  stageOrder: string[] | null;
  pipelines?: DealPipeline[] | null;
  revision: number;
}): PipelineSettings {
  return row
    ? {
        leadPipelines: row.leadPipelines ?? undefined,
        pipelines: row.pipelines ?? undefined,
        probabilities: row.probabilities,
        stageOrder: row.stageOrder ?? [...stages],
        revision: row.revision,
      }
    : initialPipelineSettings;
}
export type DealPipeline = {
  forecastMapping?: ForecastMapping;
  isDefault?: boolean;
  stageColors?: StageColors;
  stageProperties?: StageProperties;
  stagePropertyRules?: StagePropertyRules;
  stageOutcomes?: StageOutcomes;
  id: string;
  name: string;
  stageLabels?: Record<string, string>;
  stageOrder: string[];
  probabilities: Probabilities;
};
export class PipelineError extends Error {}
export type DealStageSource = readonly string[] | PipelineSettings;
export function isPipelineSettings(
  source: DealStageSource,
): source is PipelineSettings {
  return !Array.isArray(source);
}
export function pipelineList(settings: PipelineSettings): DealPipeline[] {
  return (
    settings.pipelines ?? [
      {
        id: "default",
        name: "Sales pipeline",
        forecastMapping: settings.forecastMapping,
        stageOutcomes: settings.stageOutcomes,
        stageProperties: settings.stageProperties,
        stagePropertyRules: settings.stagePropertyRules,
        stageColors: settings.stageColors,
        stageLabels: settings.stageLabels,
        stageOrder: settings.stageOrder,
        probabilities: settings.probabilities,
      },
    ]
  );
}
export function pipelineFor(settings: PipelineSettings, id = "default") {
  return pipelineList(settings).find((p) => p.id === id);
}
export function stageOutcome(source: DealStageSource, id: string, pipelineId = "default"): StageOutcome {
  return isPipelineSettings(source)
    ? pipelineFor(source, pipelineId)?.stageOutcomes?.[id] ?? legacyStageOutcome(id)
    : legacyStageOutcome(id);
}
export function dealOutcome(record: CRMRecord, source: DealStageSource): StageOutcome {
  return stageOutcome(source, record.data.stage || "", record.data.pipelineId || "default");
}
export function allStageOptions(source: DealStageSource): readonly string[] {
  return isPipelineSettings(source)
    ? [...new Set(pipelineList(source).flatMap((p) => p.stageOrder))]
    : source;
}
export function recordStages(
  source: DealStageSource,
  id = "default",
): readonly string[] {
  if (!isPipelineSettings(source)) {
    if (id !== "default")
      throw new PipelineError("Choose an available pipeline.");
    return source;
  }
  const pipeline = pipelineFor(source, id);
  if (!pipeline) throw new PipelineError("Choose an available pipeline.");
  return pipeline.stageOrder;
}
export function stageLabel(
  source: DealStageSource,
  id: string,
  pipelineId?: string,
): string {
  if (!isPipelineSettings(source)) return id;
  if (pipelineId !== undefined)
    return pipelineFor(source, pipelineId)?.stageLabels?.[id] ?? id;
  const labels = [
    ...new Set(
      pipelineList(source)
        .filter((p) => p.stageOrder.includes(id))
        .map((p) => p.stageLabels?.[id] ?? id),
    ),
  ];
  return labels.length ? labels.join(" / ") : id;
}
export function stageOptionLabels(
  source: DealStageSource,
  pipelineId?: string,
) {
  const ids =
    pipelineId === undefined
      ? allStageOptions(source)
      : recordStages(source, pipelineId);
  return Object.fromEntries(
    ids.map((id) => [id, stageLabel(source, id, pipelineId)]),
  );
}
export function movePipeline(
  data: Data,
  pipelineId: string,
  source: DealStageSource,
): Data {
  const options = recordStages(source, pipelineId);
  return {
    ...data,
    pipelineId,
    stage: data.stage && options.includes(data.stage) ? data.stage : options[0],
  };
}
export function pipelineLabel(source: DealStageSource, id = "default") {
  return isPipelineSettings(source)
    ? (pipelineFor(source, id)?.name ?? "Unavailable pipeline")
    : id === "default"
      ? "Sales pipeline"
      : "Unavailable pipeline";
}
export function updatePipelineCatalog(
  current: PipelineSettings,
  input: z.infer<typeof pipelineInput>,
) {
  const id = input.pipelineId || "default";
  const previous = pipelineFor(current, id);
  if (!previous)
    throw new Error("Pipeline unavailable. Refresh and try again.");
  const value = validatePipeline(input, {
    ...previous,
    revision: current.revision,
  });
  const name = input.name ?? previous.name;
  const list = pipelineList(current);
  if (
    list.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())
  )
    throw new Error("A pipeline with this name already exists.");
  return catalogValues(
    list.map((p) =>
      p.id === id
        ? {
            ...p,
            name,
            ...(value.forecastMapping?{forecastMapping:value.forecastMapping}:{}),
            stageLabels: value.stageLabels,
            stageOutcomes: value.stageOutcomes,
            stageProperties: value.stageProperties,
            stagePropertyRules: value.stagePropertyRules,
            stageColors: value.stageColors,
            stageOrder: value.stageOrder,
            probabilities: value.probabilities,
          }
        : p,
    ),
  );
}
export const deletePipelineInput = z.object({
  action: z.literal("delete"),
  pipelineId: z.string().min(1).max(100),
  revision: z.number().int().min(0),
});
export function removePipeline(current: PipelineSettings, pipelineId: string) {
  if (pipelineId === (pipelineList(current).find(p=>p.isDefault)?.id ?? "default")) throw new Error("Choose another default pipeline before deleting this pipeline.");
  if (!pipelineFor(current, pipelineId)) throw new Error("Pipeline unavailable. Reload settings.");
  return catalogValues(pipelineList(current).filter(p => p.id !== pipelineId));
}

/** An editable copy of saved stage settings; records and rules remain separate. */
export function pipelineCloneDraft(settings: PipelineSettings, pipelineId: string): DealPipeline {
  const source = pipelineFor(settings, pipelineId);
  if (!source) throw new Error("Pipeline unavailable. Reload settings before cloning.");
  const names = new Set(pipelineList(settings).map(p => p.name.toLowerCase()));
  let name = "";
  for (let copy = 1; ; copy++) {
    const suffix = copy === 1 ? " copy" : ` copy ${copy}`;
    name = source.name.slice(0, 80 - suffix.length).trimEnd() + suffix;
    if (!names.has(name.toLowerCase())) break;
  }
  return {
    id: "", name,
    ...(source.forecastMapping?{forecastMapping:{enabled:false,stages:{...source.forecastMapping.stages}}}:{}),
    stageColors: { ...source.stageColors },
    stagePropertyRules: (source.stagePropertyRules ?? []).map(rule => ({ ...rule, ...(rule.conditions?{conditions:rule.conditions.map(c=>({...c,values:[...c.values]}))}:{}), stages: [...rule.stages], properties: rule.properties.map(item => ({ ...item })) })),
    stageProperties: Object.fromEntries(Object.entries(source.stageProperties ?? {}).map(([stage, items]) => [stage, items.map(item => ({ ...item }))])),
    stageOrder: [...source.stageOrder],
    probabilities: { ...source.probabilities },
    stageLabels: { ...source.stageLabels },
    stageOutcomes: Object.fromEntries(source.stageOrder.map(id => [id, source.stageOutcomes?.[id] ?? legacyStageOutcome(id)])),
  };
}

export const createPipelineInput = z.object({
  forecastMapping: forecastMappingSchema.optional(),
  stageColors: stageColorsSchema.optional(),
  stageProperties: stagePropertiesSchema.optional(),
  stagePropertyRules: stagePropertyRulesSchema.optional(),
  stageOutcomes: stageOutcomesSchema.optional(),
  stageLabels: stageLabelsSchema.optional(),
  action: z.literal("create"),
  revision: z.number().int().min(0),
  name: z.string().trim().min(1).max(80),
  stageOrder: stageOrderSchema,
  probabilities: z.record(z.string(), z.number().int().min(0).max(100)),
});
export function createPipeline(
  current: PipelineSettings,
  input: z.infer<typeof createPipelineInput>,
  id: string,
) {
  const list = pipelineList(current);
  if (list.length >= 20)
    throw new Error("This workspace supports up to 20 pipelines.");
  if (list.some((p) => p.name.toLowerCase() === input.name.toLowerCase()))
    throw new Error("A pipeline with this name already exists.");
  const value = validatePipeline(input, {
    stageOrder: input.stageOrder,
    probabilities: {},
    revision: current.revision,
  });
  return catalogValues([
    ...list,
    {
      id,
      name: input.name,
      ...(value.forecastMapping?{forecastMapping:value.forecastMapping}:{}),
      stageLabels: value.stageLabels,
      stageOutcomes: value.stageOutcomes,
      stageProperties: value.stageProperties,
            stagePropertyRules: value.stagePropertyRules,
      stageColors: value.stageColors,
      stageOrder: value.stageOrder,
      probabilities: value.probabilities,
    },
  ]);
}
function catalogValues(pipelines: DealPipeline[]) {
  const first = pipelines.find((p) => p.id === "default") ?? pipelines.find(p=>p.isDefault);
  if (!first) throw new Error("Keep an available default pipeline.");
  return {
    pipelines,
    stageOrder: first.stageOrder,
    probabilities: first.probabilities,
  };
}
export type PipelineSettings = {
  forecastMapping?: ForecastMapping;
  leadPipelines?: import("./lead-pipelines").LeadPipeline[];
  propertyLogic?: import("./property-logic").PropertyLogicCatalog;
  tickets?: import("./ticket-pipelines").TicketCatalog;
  stageColors?: StageColors;
  stageProperties?: StageProperties;
  stagePropertyRules?: StagePropertyRules;
  stageOutcomes?: StageOutcomes;
  stageLabels?: Record<string, string>;
  pipelines?: DealPipeline[];
  stageOrder: string[];
  probabilities: Probabilities;
  revision: number;
};
export const initialPipelineSettings: PipelineSettings = {
  stageOrder: [...stages],
  probabilities: defaultProbabilities,
  revision: 0,
};
export function dealProbability(
  record: CRMRecord,
  probabilities: Probabilities | PipelineSettings,
) {
  const values = Array.isArray(probabilities.stageOrder)
    ? pipelineFor(probabilities as PipelineSettings, record.data.pipelineId)
        ?.probabilities
    : (probabilities as Probabilities);
  return values?.[record.data.stage as Stage] ?? 0;
}
export function weightedAmount(
  record: CRMRecord,
  probabilities: Probabilities | PipelineSettings,
) {
  return (
    ((record.data.amount || 0) * dealProbability(record, probabilities)) / 100
  );
}
const round = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
export function pipelineForecast(
  records: CRMRecord[],
  probabilities: Probabilities,
  stageOrder: readonly string[] = stages,
  outcomes: StageOutcomes = {},
) {
  const deals = records.filter((record) => record.kind === "deals");
  const byStage = stageOrder.map((stage) => {
    const rows = deals.filter((record) => record.data.stage === stage);
    const amount = rows.reduce(
      (sum, record) => sum + (record.data.amount || 0),
      0,
    );
    return {
      stage,
      count: rows.length,
      amount: round(amount),
      probability: probabilities[stage],
      weighted: round((amount * probabilities[stage]) / 100),
    };
  });
  const open = deals.filter(
    (record) =>
      (outcomes[record.data.stage || ""] ?? legacyStageOutcome(record.data.stage || "")) === "open",
  );
  return {
    byStage,
    openCount: open.length,
    openAmount: round(open.reduce((sum, r) => sum + (r.data.amount || 0), 0)),
    weightedOpen: round(
      open.reduce((sum, r) => sum + weightedAmount(r, probabilities), 0),
    ),
  };
}

export function catalogForecast(
  records: CRMRecord[],
  settings: PipelineSettings,
  pipelineId?: string,
) {
  const rows = records.filter(
    (r) =>
      r.kind === "deals" &&
      (!pipelineId || (r.data.pipelineId || "default") === pipelineId),
  );
  const open = rows.filter(
    (r) => dealOutcome(r, settings) === "open",
  );
  return {
    openCount: open.length,
    openAmount: round(open.reduce((n, r) => n + (r.data.amount || 0), 0)),
    weightedOpen: round(
      open.reduce((n, r) => n + weightedAmount(r, settings), 0),
    ),
  };
}
