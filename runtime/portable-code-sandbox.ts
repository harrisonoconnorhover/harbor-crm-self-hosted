import {parentPort,workerData} from 'node:worker_threads';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import type {PortableCodePayload} from '../lib/portable-workflow-code';
import {evaluateCode} from '../lib/workflows/sandbox';

const {code,inputFields}=workerData as Pick<PortableCodePayload,'code'|'inputFields'>;
try{
  const engine=await newQuickJSWASMModuleFromVariant(variant);
  const {outputFields}=evaluateCode(engine,code,{inputFields,outputs:{}},{deterministic:true});
  parentPort?.postMessage(outputFields);
}catch{
  // Guest errors and logs can contain contact data. Send only the outcome.
  parentPort?.postMessage(null);
}
