import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/host.mjs';
import {createAnalysisPlan,analyzeReport} from '../src/report.mjs';

const snapshot=()=>({title:'test',createdAt:'fixed',repositories:[{path:'.',type:'git',a:'a'.repeat(40),b:'b'.repeat(40),requestedA:'main',requestedB:'release',files:['api.js'],diff:'-old\n+new',summary:'api.js',diffHash:'hash'}],context:[],limitations:[]});
const route={provider:'fixture',model:'mock'};
function fixture(options={}){
  let clock=1000,calls=0;const sessions=new Map([['s',{header:{cwd:'/workspace'}}],['other',{header:{cwd:'/workspace'}}]]);
  const ctx={sessions,llm:{async *stream(){calls++;yield {type:'finish',reason:{kind:'stop'}};}}};
  const plan=(value,{inputBudget=24000}={})=>({id:'plan-'+inputBudget,inputBudget,estimated:true,batches:[{id:'one',evidenceIds:['e1'],inputBytes:50,snapshot:{secret:'not-public'}},{id:'two',evidenceIds:['e2'],inputBytes:50}],coverage:{total:2,excluded:[]}});
  const analyze=async(llm,r,s,{completed,onProgress})=>{for(const id of ['one','two']){if(!completed.has(id)){for await(const chunk of llm.stream({})){}completed.set(id,{});onProgress({phase:'analyzing',completed:completed.size,total:2,label:'分析'});}}return {markdown:'## 对外接口变更\n待确认\n## QA\n待测试',coverage:{total:2,analyzed:2,remaining:0},completed};};
  const handler=createHandler(ctx,{capture:async()=>snapshot(),scan:async()=>({repositories:[],warnings:[]}),refs:async()=>['refs/heads/main'],plan,analyze,now:()=>clock,...options});
  return {handler,sessions,setClock:value=>{clock=value;},calls:()=>calls};
}
async function preview(f){const result=await f.handler('preview',{sessionId:'s',request:{}});assert.equal(result.ok,true);return result.value;}
const send=(p,extra={})=>({sessionId:'s',previewId:p.previewId,planId:p.analysisPlan.id,route,sendToModel:true,...extra});

test('preview is local, expires explicitly and public plan contains no raw batch payload',async()=>{
  const f=fixture(),p=await preview(f);assert.equal(f.calls(),0);assert.equal(p.expiresAt,601000);assert.equal(p.analysisPlan.batches.length,2);assert.equal(JSON.stringify(p.analysisPlan).includes('not-public'),false);assert.match(p.markdown,/未调用模型/);
  assert.equal((await f.handler('generate',send(p,{sendToModel:false}))).error.code,'code-report/consent-required');
  assert.equal((await f.handler('generate',send(p,{planId:'old'}))).error.code,'code-report/plan-mismatch');assert.equal(f.calls(),0);
  assert.equal((await f.handler('generate',send(p,{sessionId:'other'}))).ok,false);
  assert.equal((await f.handler('generate',send(p))).ok,true);assert.equal(f.calls(),2);
  assert.equal((await f.handler('generate',send(p))).error.code,'code-report/preview-expired');
});
test('expiry cannot be extended by replanning and expired preview never dispatches',async()=>{
  const f=fixture(),p=await preview(f);f.setClock(600999);
  const replanned=await f.handler('analysis-plan',{sessionId:'s',previewId:p.previewId,inputBudget:8000});assert.equal(replanned.ok,true);assert.equal(replanned.value.expiresAt,p.expiresAt);
  f.setClock(p.expiresAt);const result=await f.handler('generate',send(p,{planId:replanned.value.analysisPlan.id}));assert.equal(result.error.code,'code-report/preview-expired');assert.equal(f.calls(),0);
});
test('replan is bound to current session, validates budget and invalidates old plan',async()=>{
  const f=fixture(),p=await preview(f);
  for(const inputBudget of [3999,64001,8000.5,'8000'])assert.equal((await f.handler('analysis-plan',{sessionId:'s',previewId:p.previewId,inputBudget})).error.code,'code-report/input');
  assert.equal((await f.handler('analysis-plan',{sessionId:'other',previewId:p.previewId,inputBudget:8000})).ok,false);
  assert.equal((await f.handler('analysis-plan',{sessionId:'s',previewId:p.previewId,inputBudget:8000})).ok,true);
  assert.equal((await f.handler('generate',send(p))).error.code,'code-report/plan-mismatch');assert.equal(f.calls(),0);
});
test('failure keeps only successful batches, explicit retry skips them and route change clears cache',async()=>{
  const seen=[];let fail=true;
  const f=fixture({analyze:async(llm,r,s,{completed})=>{for(const id of ['one','two']){if(completed.has(id))continue;seen.push(r.model+':'+id);if(id==='two'&&fail){const e=new Error('断线');e.completed=completed;throw e;}completed.set(id,{validated:true});}return {markdown:'## 对外接口变更\n待确认',coverage:{total:2,analyzed:2},completed};}});
  const p=await preview(f),first=await f.handler('generate',send(p));assert.equal(first.ok,false);assert.equal(first.error.details.remainingBatches,1);assert.equal(first.error.details.requiresConfirmation,true);
  assert.equal((await f.handler('generate',send(p,{sendToModel:false}))).ok,false);assert.deepEqual(seen,['mock:one','mock:two']);
  fail=false;assert.equal((await f.handler('generate',send(p))).ok,true);assert.deepEqual(seen,['mock:one','mock:two','mock:two']);
  fail=true;const q=await preview(f);await f.handler('generate',send(q));fail=false;
  await f.handler('generate',send(q,{route:{...route,model:'new'}}));assert.deepEqual(seen.slice(-2),['new:one','new:two']);
});
test('busy preview cannot be released, replanned or consumed concurrently',async()=>{
  let resume,started;const ready=new Promise(r=>{started=r;});
  const f=fixture({analyze:async()=>{started();await new Promise(r=>{resume=r;});return {markdown:'## 对外接口变更\n待确认',coverage:{}};}}),p=await preview(f);
  const pending=f.handler('generate',send(p));await ready;
  assert.equal((await f.handler('release-preview',{sessionId:'s',previewId:p.previewId})).ok,false);
  assert.equal((await f.handler('analysis-plan',{sessionId:'s',previewId:p.previewId,inputBudget:8000})).error.code,'code-report/busy');
  assert.equal((await f.handler('generate',send(p))).error.code,'code-report/busy');resume();assert.equal((await pending).ok,true);
});
test('every dispatch rechecks authoritative cwd; no next batch after session changes',async()=>{
  const f=fixture({analyze:async(llm)=>{for await(const chunk of llm.stream({})){}f.sessions.set('s',{header:{cwd:'/changed'}});for await(const chunk of llm.stream({})){}throw new Error('unreachable');}});
  const p=await preview(f),result=await f.handler('generate',send(p));assert.equal(result.error.code,'code-report/session-changed');assert.equal(f.calls(),1);
});
test('expiry is checked at the first actual model dispatch, not just task claim',async()=>{
  const f=fixture({analyze:async(llm)=>{f.setClock(601000);for await(const chunk of llm.stream({})){}throw new Error('unreachable');}});
  const p=await preview(f),result=await f.handler('generate',send(p));assert.equal(result.error.code,'code-report/preview-expired');assert.equal(f.calls(),0);
});
test('validated results survive cancellation after analysis and before response delivery',async()=>{
  const ac=new AbortController(),finished=new Map([['one',{}],['two',{}]]);
  const f=fixture({analyze:async()=>{ac.abort();return {markdown:'done',completed:finished};}});const p=await preview(f);
  const result=await f.handler('generate',send(p),ac.signal);assert.equal(result.error.code,'code-report/cancelled');assert.equal(result.error.details.completedBatches,2);
});
test('pre-cancelled requests and invalid routes do not dispatch',async()=>{
  const f=fixture(),p=await preview(f),ac=new AbortController();ac.abort();assert.equal((await f.handler('generate',send(p),ac.signal)).error.code,'code-report/cancelled');
  assert.equal((await f.handler('generate',send(p,{route:{provider:'',model:'x'}}))).error.code,'code-report/input');assert.equal(f.calls(),0);
});
test('local evidence remains available when default analysis plan exceeds limits',async()=>{
  const f=fixture({plan:()=>{throw new Error('需要更大预算');}}),p=await preview(f);assert.equal(p.analysisPlan,null);assert.match(p.planError.message,/预算/);assert.match(p.markdown,/差异证据/);assert.equal(f.calls(),0);
});
test('completed paid report is recoverable by read-only operation id and isolated by session/cwd/TTL',async()=>{
  const f=fixture(),p=await preview(f),payload=send(p,{operationId:'paid-result'});
  const generated=await f.handler('generate',payload);assert.equal(generated.ok,true);assert.equal(f.calls(),2);
  for(let i=0;i<3;i++){
    const recovered=await f.handler('result',{sessionId:'s',operationId:'paid-result'});assert.equal(recovered.ok,true);assert.deepEqual(recovered.value,{status:'completed',result:generated.value});
  }
  assert.equal(f.calls(),2);
  assert.equal((await f.handler('result',{sessionId:'other',operationId:'paid-result'})).ok,false);
  f.sessions.set('s',{header:{cwd:'/changed'}});assert.equal((await f.handler('result',{sessionId:'s',operationId:'paid-result'})).ok,false);
  f.sessions.set('s',{header:{cwd:'/workspace'}});f.setClock(601001);assert.equal((await f.handler('result',{sessionId:'s',operationId:'paid-result'})).error.code,'code-report/result-unavailable');
});
test('evicted completed result body is unknown, never reported as a failed model call',async()=>{
  const f=fixture({analyze:async()=>({markdown:'x'.repeat(17*1024*1024),coverage:{}})});
  for(const operationId of ['large-first','large-second']){const p=await preview(f);assert.equal((await f.handler('generate',send(p,{operationId}))).ok,true);}
  const recovered=await f.handler('result',{sessionId:'s',operationId:'large-first'});
  assert.equal(recovered.ok,false);assert.equal(recovered.error.code,'code-report/result-unavailable');assert.match(recovered.error.message,/曾完成/);
  assert.equal((await f.handler('result',{sessionId:'s',operationId:'large-second'})).value.status,'completed');
});
test('read-only recovery reports a pending operation without starting another analysis',async()=>{
  let finish,started;const ready=new Promise(resolve=>{started=resolve;});
  const f=fixture({analyze:async()=>{started();await new Promise(resolve=>{finish=resolve;});return {markdown:'done',coverage:{}};}}),p=await preview(f);
  const pending=f.handler('generate',send(p,{operationId:'pending-result'}));await ready;
  assert.equal((await f.handler('result',{sessionId:'s',operationId:'pending-result'})).value.status,'pending');assert.equal(f.calls(),0);
  finish();await pending;assert.equal((await f.handler('result',{sessionId:'s',operationId:'pending-result'})).value.status,'completed');
});
test('production plan and analyzer compose with host checkpoint, paid retry, route change and replan',async()=>{
  const source=snapshot();source.repositories[0].diff='diff --git a/api.js b/api.js\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-'+('旧'.repeat(7000))+'\n+new\n';
  let calls=0,failOn=2;const modelCalls=[];
  const ctx={sessions:new Map([['s',{header:{cwd:'/workspace'}}]]),llm:{async *stream(input){
    calls++;modelCalls.push(input.model);if(calls===failOn)throw new Error('response interrupted');
    const data=JSON.parse(input.messages[0].content[0].text);
    yield {type:'text-delta',text:JSON.stringify({changes:[{text:'内容变化待确认',evidenceIds:[data.evidence[0].id]}],interfaces:[],impacts:[],qa:[],unknowns:[{text:'调用方未提供',evidenceIds:[]}]})};yield {type:'finish',reason:{kind:'stop'}};
  }}};
  const handler=createHandler(ctx,{capture:async()=>source,plan:createAnalysisPlan,analyze:analyzeReport});
  async function getPreview(){const p=await handler('preview',{sessionId:'s',request:{}});assert.equal(p.ok,true);const replanned=await handler('analysis-plan',{sessionId:'s',previewId:p.value.previewId,inputBudget:8000});assert.equal(replanned.ok,true);return {...p.value,analysisPlan:replanned.value.analysisPlan};}
  const p=await getPreview(),count=p.analysisPlan.batches.length;assert.ok(count>2);
  const failure=await handler('generate',send(p));assert.equal(failure.ok,false);assert.equal(failure.error.details.completedBatches,1);assert.equal(failure.error.details.remainingBatches,count-1);
  assert.equal(failure.error.details.coverage.processed>0,true);failOn=0;
  const success=await handler('generate',send(p));assert.equal(success.ok,true);assert.equal(calls,count+1);assert.equal(success.value.coverage.completedBatches,count);assert.match(success.value.markdown,/证据索引/);
  const q=await getPreview();failOn=calls+2;await handler('generate',send(q));failOn=0;const before=calls;
  assert.equal((await handler('generate',send(q,{route:{...route,model:'changed'}}))).ok,true);assert.equal(calls-before,count);assert.equal(modelCalls.at(-1),'changed');
  const r=await getPreview();failOn=calls+2;await handler('generate',send(r));failOn=0;
  const newPlan=await handler('analysis-plan',{sessionId:'s',previewId:r.previewId,inputBudget:12000});const beforeReplan=calls;
  assert.equal((await handler('generate',send(r,{planId:newPlan.value.analysisPlan.id}))).ok,true);assert.equal(calls-beforeReplan,newPlan.value.analysisPlan.batches.length);
});
test('aborting an adapter that ignores signal releases active capacity and preview claim',async()=>{
  let calls=0,started;const ready=new Promise(resolve=>{started=resolve;});
  const ctx={sessions:new Map([['s',{header:{cwd:'/workspace'}}]]),llm:{stream(){calls++;started();return {[Symbol.asyncIterator](){return this;},next(){return new Promise(()=>{});},return(){return new Promise(()=>{});}};}}};
  const handler=createHandler(ctx,{capture:async()=>snapshot()});
  const local=await handler('preview',{sessionId:'s',request:{}});const p=local.value,ac=new AbortController();
  const active=handler('generate',send(p,{operationId:'hung-model'}),ac.signal);await ready;ac.abort();
  const result=await active;assert.equal(result.error.code,'code-report/cancelled');assert.equal(calls,1);
  assert.equal((await handler('release-preview',{sessionId:'s',previewId:p.previewId})).ok,true);
  assert.equal((await handler('preview',{sessionId:'s',request:{}})).ok,true);
});
test('refs are session-derived and cannot override cwd via payload',async()=>{
  let root;const f=fixture({refs:async(cwd,name)=>{root=cwd;assert.equal(name,'.');return ['refs/heads/main'];}});
  const result=await f.handler('refs',{sessionId:'s',repositoryPath:'.',cwd:'/etc'});assert.equal(result.ok,true);assert.equal(root,'/workspace');assert.deepEqual(result.value.refs,['refs/heads/main']);
});
