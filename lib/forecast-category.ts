import {isPipelineSettings,pipelineFor,type DealStageSource,type DealPipeline} from './forecast';
import {standardField} from './standard-properties';
import type {Property} from './workspace';
import type {Data} from './crm';
import {InputError} from './input-error';

export function validateForecastMapping(pipeline:DealPipeline,properties:Property[]){
 const choices=standardField('deals','forecastCategory',properties)!.options!;
 for(const category of Object.values(pipeline.forecastMapping?.stages||{}))
  if(!choices.includes(category))throw new InputError('Choose an available forecast category for every mapped stage.');
}

// Stored assignments are changed only on creation or an actual stage/pipeline move.
// A later category-only edit survives until the next mapped move; no read-time fallback.
export function applyForecastMapping(data:Data,previous:Data|undefined,catalog:DealStageSource,properties:Property[]):Data{
 if(!isPipelineSettings(catalog))return data;
 const pipelineId=data.pipelineId||'default',mapping=pipelineFor(catalog,pipelineId)?.forecastMapping;
 if(!mapping?.enabled)return data;
 const moved=previous&&(data.stage!==previous.stage||pipelineId!==(previous.pipelineId||'default'));
 if(previous&&!moved||!previous&&data.forecastCategory)return data;
 const category=Object.hasOwn(mapping.stages,data.stage||'')?mapping.stages[data.stage!]:undefined;
 if(!category)return data;
 if(!standardField('deals','forecastCategory',properties)!.options!.includes(category))throw new InputError('The mapped forecast category is unavailable. Update pipeline settings before moving this deal.');
 return {...data,forecastCategory:category};
}
