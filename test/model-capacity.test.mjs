import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {modelCapacity} from '../src/model-capacity.mjs';
import {createAnalysisPlan} from '../src/analysis.mjs';
import {createHandler} from '../src/host.mjs';
import {withDispositions} from './analysis-fixture.mjs';
const route={provider:'p',model:'m'};
const snapshot=()=>({title:'capacity',createdAt:'now',repositories:[],limitations:[],context:Array.from({length:100},(_,i)=>({path:'source-'+i+'.cpp',text:'x'.repeat(1000),hash:'h',provenance:'current-workspace'}))});
test('1M configured context derives budget above 64KB with output and safety reserves',async()=>{
 const c=await modelCapacity({resolveModelInfo:async(p,m)=>{assert.equal(p,'p');assert.equal(m,'m');return {context:{contextWindow:1000000},defaultMaxTokens:128000};}},route);
 assert.equal(c.inputBudget,867232);assert.equal(c.outputTokens,32768);assert.equal(c.safetyTokens,100000);
 const p=createAnalysisPlan(snapshot(),{inputBudget:c.inputBudget,capacity:c});assert.equal(p.batches.length,1);assert.equal(p.batches[0].evidenceIds.length,100);
 assert.ok(p.batches[0].inputBytes>64000);assert.equal(p.coverage.originalSourceBytes,100000);
});
test('missing metadata has explicit fallback; invalid configured small window fails closed',async()=>{
 for(const llm of [{},{resolveModelInfo:async()=>{throw new Error('secret');}},{resolveModelInfo:async()=>({context:{contextWindow:Infinity}})}]){const c=await modelCapacity(llm,route);assert.equal(c.source,'fallback');assert.equal(c.inputBudget,64000);assert.ok(!JSON.stringify(c).includes('secret'));}
 await assert.rejects(modelCapacity({resolveModelInfo:async()=>({context:{contextWindow:4096}})},route),/上下文不足/);
 const c=await modelCapacity({resolveModelInfo:async()=>({context:{contextWindow:32000},defaultMaxTokens:1024})},route);assert.equal(c.outputTokens,1024);assert.equal(c.inputBudget,27776);
});
test('host binds capacity to route and rechecks configuration before dispatch without model calls',async()=>{
 let window=1000000,calls=0;const llm={resolveModelInfo:async()=>({context:{contextWindow:window},defaultMaxTokens:128000}),async *stream(input){calls++;const p=JSON.parse(input.messages[0].content[0].text);yield {type:'text-delta',text:JSON.stringify(withDispositions({changes:[],interfaces:[],impacts:[],qa:[],unknowns:[]},p.evidence))};yield {type:'finish',reason:{kind:'stop'}};}};
 const h=createHandler({sessions:new Map([['s',{header:{cwd:'/work'}}]]),agentDefaultModel:{currentSelection:()=>route},llm},{capture:async()=>snapshot()});
 const p=(await h('preview',{sessionId:'s',request:{}})).value;assert.equal(p.analysisPlan.batches.length,1);assert.equal(p.analysisPlan.capacity.source,'host-model');assert.equal(calls,0);
 const send=(extra={})=>({sessionId:'s',previewId:p.previewId,planId:p.analysisPlan.id,operationId:randomUUID(),sendToModel:true,route,...extra});
 assert.equal((await h('generate',send({route:{...route,model:'other'}}))).error.code,'code-report/plan-mismatch');assert.equal(calls,0);
 window=500000;assert.equal((await h('generate',send())).error.code,'code-report/plan-mismatch');assert.equal(calls,0);
 const q=await h('analysis-plan',{sessionId:'s',previewId:p.previewId,route});assert.equal(q.ok,true);assert.ok(q.value.analysisPlan.inputBudget>64000);
 const denied=await h('analysis-plan',{sessionId:'s',previewId:p.previewId,route,inputBudget:1000000});assert.equal(denied.error.code,'code-report/model-capacity');
 assert.equal((await h('generate',send({planId:p.analysisPlan.id}))).error.code,'code-report/plan-mismatch');
 const done=await h('generate',send({planId:q.value.analysisPlan.id}));assert.equal(done.ok,true,JSON.stringify(done));assert.equal(calls,1);
});
test('output-derived evidence budget scales with configured output and sampled mode stays one request',async()=>{
 const small=await modelCapacity({resolveModelInfo:async()=>({context:{contextWindow:1000000},defaultMaxTokens:8192})},route);
 const large=await modelCapacity({resolveModelInfo:async()=>({context:{contextWindow:1000000},defaultMaxTokens:32768})},route);
 const a=createAnalysisPlan(snapshot(),{inputBudget:small.inputBudget,capacity:small}),b=createAnalysisPlan(snapshot(),{inputBudget:large.inputBudget,capacity:large});
 assert.ok(a.batches.length>b.batches.length);assert.notEqual(a.id,b.id);assert.equal(a.batches.flatMap(x=>x.evidenceIds).length,100);
 const summary=createAnalysisPlan(snapshot(),{inputBudget:large.inputBudget,capacity:large,strategy:'single-request'});assert.equal(summary.batches.length,1);assert.ok(summary.batches[0].evidenceIds.length<=128);
});
