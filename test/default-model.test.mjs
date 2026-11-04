import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHandler} from '../src/host.mjs';
import {inject} from '../index.mjs';

const initial={provider:'host-provider',model:'host-model'};
const snapshot=()=>({title:'default routing',createdAt:'fixed',repositories:[{path:'.',type:'git',a:'a'.repeat(40),b:'b'.repeat(40),requestedA:'main',requestedB:'release',files:['api.js'],diff:'-old\n+new',summary:'api.js',diffHash:'hash'}],context:[],limitations:[]});
function fixture({selection=initial,missing=false,direct=false,throws=false,dependencies={}}={}){
  let reads=0,lookups=0,current=selection;const calls=[];
  const service={currentSelection(){reads++;if(throws)throw new Error('private host configuration');return current;},saveSelection(){assert.fail('must not write host configuration');}};
  const ctx={sessions:new Map([['s',{header:{cwd:'/workspace'}}]]),llm:{async *stream(input){
    calls.push(input);
    const evidence=JSON.parse(input.messages[0].content[0].text).evidence;
    yield {type:'text-delta',text:JSON.stringify({changes:[{text:'Change requires review',evidenceIds:[evidence[0].id]}],interfaces:[],impacts:[],qa:[],unknowns:[]})};
    yield {type:'finish',reason:{kind:'stop'}};
  }}};
  if(direct){if(!missing)ctx.agentDefaultModel=service;}
  else ctx.get=name=>{lookups++;assert.equal(name,'agentDefaultModel');return missing?undefined:service;};
  return {handler:createHandler(ctx,{capture:async()=>snapshot(),...dependencies}),calls,reads:()=>reads,lookups:()=>lookups,setSelection:value=>{current=value;}};
}
async function preview(f){const result=await f.handler('preview',{sessionId:'s',request:{}});assert.equal(result.ok,true);return result.value;}
function payload(p,extra={}){return {sessionId:'s',previewId:p.previewId,planId:p.analysisPlan.id,operationId:randomUUID(),sendToModel:true,route:{mode:'default',...p.defaultRoute},...extra};}

test('optional host default is exposed read-only and dispatched using the displayed provider/model',async()=>{
  assert.equal(inject.includes('agentDefaultModel'),false);
  const f=fixture({selection:{...initial,reasoningEffort:'high'}}),p=await preview(f);
  assert.deepEqual(p.defaultRoute,initial);assert.equal(p.defaultRouteError,null);assert.equal(f.reads(),1);assert.equal(f.calls.length,0);
  const generated=await f.handler('generate',payload(p));assert.equal(generated.ok,true);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].provider,initial.provider);assert.equal(f.calls[0].model,initial.model);assert.equal(f.reads(),1);assert.equal(f.lookups(),1);
  assert.match(generated.value.markdown,/host-provider/);assert.match(generated.value.markdown,/host-model/);
});

test('plain host context service access is supported without mandatory dependency',async()=>{
  const f=fixture({direct:true}),p=await preview(f);assert.deepEqual(p.defaultRoute,initial);assert.equal((await f.handler('generate',payload(p))).ok,true);
});

test('missing service gives a clear unavailable default but legacy explicit routes still work',async()=>{
  for(const direct of [false,true]){
    const f=fixture({missing:true,direct}),p=await preview(f);assert.equal(p.defaultRoute,null);assert.equal(p.defaultRouteError.code,'code-report/default-unavailable');assert.match(p.defaultRouteError.message,/手动/);
    const blocked=await f.handler('generate',payload(p));assert.equal(blocked.error.code,'code-report/default-unavailable');assert.equal(f.calls.length,0);
    const generated=await f.handler('generate',payload(p,{route:{provider:'manual-provider',model:'manual-model'}}));assert.equal(generated.ok,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].provider,'manual-provider');assert.equal(f.calls[0].model,'manual-model');
  }
});

test('malformed or throwing host config is unavailable and never leaks host errors',async()=>{
  for(const selection of [null,{},'bad',{provider:'',model:'m'},{provider:'p',model:'  '},{provider:42,model:'m'},{provider:'p',model:'m'.repeat(201)}]){
    const f=fixture({selection}),p=await preview(f);assert.equal(p.defaultRoute,null);assert.equal(p.defaultRouteError.code,'code-report/default-unavailable');assert.equal((await f.handler('generate',payload(p))).ok,false);assert.equal(f.calls.length,0);
  }
  const f=fixture({throws:true}),p=await preview(f);assert.equal(p.defaultRoute,null);assert.doesNotMatch(p.defaultRouteError.message,/private/);
});

test('default provider/model tampering or omitted displayed IDs never dispatches',async()=>{
  const f=fixture(),p=await preview(f);
  for(const route of [{mode:'default',...initial,model:'other'},{mode:'default',...initial,provider:'other'},{mode:'default'}]){
    const result=await f.handler('generate',payload(p,{route}));assert.equal(result.error.code,'code-report/default-route-mismatch');
  }
  assert.equal(f.calls.length,0);assert.equal((await f.handler('generate',payload(p))).ok,true);
});

test('default changes after preview cannot silently reroute; preview response cannot mutate stored selection',async()=>{
  const f=fixture(),p=await preview(f),sent=payload(p);
  f.setSelection({provider:'new-provider',model:'new-model'});p.defaultRoute.model='mutated-response';
  assert.equal((await f.handler('generate',sent)).ok,true);assert.equal(f.calls[0].model,initial.model);assert.equal(f.calls[0].provider,initial.provider);assert.equal(f.reads(),1);
  const next=await preview(f);assert.deepEqual(next.defaultRoute,{provider:'new-provider',model:'new-model'});
});

test('replanning retains pinned default route without rereading current host defaults',async()=>{
  const f=fixture(),p=await preview(f);f.setSelection(null);
  const replanned=await f.handler('analysis-plan',{sessionId:'s',previewId:p.previewId,inputBudget:32000});assert.equal(replanned.ok,true);assert.deepEqual(replanned.value.defaultRoute,initial);assert.equal(replanned.value.defaultRouteError,null);assert.equal(f.reads(),1);
  replanned.value.defaultRoute.model='changed response';
  assert.equal((await f.handler('generate',payload(p,{planId:replanned.value.analysisPlan.id}))).ok,true);assert.equal(f.calls[0].model,initial.model);assert.equal(f.reads(),1);
});

test('replay is checked without resolving current defaults and never redispatches',async()=>{
  const f=fixture(),p=await preview(f),sent=payload(p),generated=await f.handler('generate',sent);assert.equal(generated.ok,true);
  f.setSelection(null);assert.deepEqual(await f.handler('generate',sent),generated);assert.equal(f.calls.length,1);assert.equal(f.reads(),1);assert.equal(f.lookups(),1);
  const result=await f.handler('result',{sessionId:'s',operationId:sent.operationId});assert.equal(result.value.execution.dispatchCount,1);assert.equal(result.value.status,'completed');
});

test('operation identity distinguishes default from manual even for identical IDs',async()=>{
  for(const mode of [undefined,'explicit']){
    const f=fixture(),p=await preview(f),sent=payload(p);assert.equal((await f.handler('generate',sent)).ok,true);
    const route={...initial,...(mode?{mode}:{})};const conflict=await f.handler('generate',{...sent,route});assert.equal(conflict.error.code,'code-report/operation-conflict');assert.equal(f.calls.length,1);
  }
});

test('partial batch cache keeps the resolved route key and clears when explicit IDs change',async()=>{
  let fail=true;const seen=[];
  const f=fixture({dependencies:{
    plan:()=>({id:'partial',batches:[{id:'one',evidenceIds:[],inputBytes:10},{id:'two',evidenceIds:[],inputBytes:10}],coverage:{}}),
    analyze:async(llm,route,snapshot,{completed})=>{
      for(const id of ['one','two']){if(completed.has(id))continue;seen.push(route.model+':'+id);if(fail&&id==='two'){const error=new Error('interrupted');error.completed=completed;throw error;}completed.set(id,{});}
      return {markdown:'done',completed};
    }
  }});
  const p=await preview(f);assert.equal((await f.handler('generate',payload(p))).ok,false);
  fail=false;assert.equal((await f.handler('generate',payload(p,{route:{...initial}}))).ok,true);
  assert.deepEqual(seen,['host-model:one','host-model:two','host-model:two']);
  fail=true;const q=await preview(f);assert.equal((await f.handler('generate',payload(q))).ok,false);fail=false;
  assert.equal((await f.handler('generate',payload(q,{route:{provider:'manual',model:'other'}}))).ok,true);assert.deepEqual(seen.slice(-2),['other:one','other:two']);
});

test('default routes retain explicit source-send confirmation and plan binding',async()=>{
  const f=fixture(),p=await preview(f);
  assert.equal((await f.handler('generate',payload(p,{sendToModel:false}))).error.code,'code-report/consent-required');
  assert.equal((await f.handler('generate',payload(p,{planId:'unconfirmed-plan'}))).error.code,'code-report/plan-mismatch');assert.equal(f.calls.length,0);
});
