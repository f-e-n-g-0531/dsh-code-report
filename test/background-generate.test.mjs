import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick,setTimeout as delay} from 'node:timers/promises';
import {createHandler} from '../src/host.mjs';
import {cancellableChunks} from '../src/analysis.mjs';
import {createLifecycleController} from '../src/lifecycle-controller.mjs';
import {createResultStore} from '../src/result-state.mjs';

const session={id:'a',cwd:'/fixture'},route={provider:'fixture',model:'model'};
const pick={timeout:6000};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fixture=({stream=async function*(){},analyze,saveReport=async()=>({status:'saved',path:'/fixture/report.md'}),resolveModelInfo}={})=>{
 let clock=1000;
 const ctx={sessions:new Map([['a',{header:{cwd:session.cwd}}],['b',{header:{cwd:session.cwd}}]]),llm:{stream,resolveModelInfo}};
 const handler=createHandler(ctx,{
  now:()=>clock,saveReport,
  capture:async()=>({title:'test',createdAt:'fixed',repositories:[],context:[],limitations:[]}),
  plan:(snapshot,{strategy,inputBudget})=>({id:strategy+'-'+inputBudget,strategy,inputBudget,batches:['one','two','three','four'].map(id=>({id,evidenceIds:[]}))}),
  analyze:analyze??(async(llm,route,snapshot,{signal})=>{for await(const chunk of cancellableChunks(llm.stream({signal}),signal)){}return {markdown:'REPORT',completed:new Map()};})
 });
 const rpc=async(endpoint,payload,signal)=>{
  const response=await handler(endpoint,payload,signal);
  if(!response.ok)throw Object.assign(new Error(response.error.message),response.error);
  return response.value;
 };
 const request=async extra=>{
  const runtime=await rpc('runtime-info',{});
  assert.equal(runtime.capabilities.asyncGenerate,true);
  const preview=await rpc('preview',{sessionId:'a',route,request:{analysisStrategy:extra?.strategy}});
  return {preview,request:{sessionId:'a',operationId:randomUUID(),previewId:preview.previewId,planId:preview.analysisPlan.id,sendToModel:true,route,backendInstanceId:runtime.backendInstanceId}};
 };
 return {rpc,request,ctx,setClock:value=>{clock=value;}};
};
async function until(read,predicate){
 for(let i=0;i<200;i++){const value=await read();if(predicate(value))return value;await delay(2);}
 assert.fail('expected condition was not observed');
}
const terminal=(f,request)=>until(()=>f.rpc('result',request),v=>v.status!=='pending');

test('background acknowledgement is detached; duplicate identity is width-bound; receipt is owner-bound and report precedes save',pick,async()=>{
 let calls=0;const model=deferred(),disk=deferred();
 const f=fixture({async *stream(){calls++;await model.promise;},saveReport:()=>disk.promise});
 try{
  const {request}=await f.request();const transport=new AbortController();
  const ack=await f.rpc('generate-start',{...request,concurrency:4},transport.signal);
  assert.equal(ack.status,'pending');assert.equal(calls,0);transport.abort();
  assert.equal((await f.rpc('generate-start',{...request,concurrency:4})).operationId,request.operationId);
  await assert.rejects(f.rpc('generate-start',{...request,concurrency:2}),{code:'code-report/operation-conflict'});
  await assert.rejects(f.rpc('generate-cancel',{...request,sessionId:'b'}),{code:'code-report/result-unavailable'});
  await until(()=>calls,v=>v===1);
  const running=await f.rpc('progress',request);
  assert.equal(running.concurrency,4);assert.equal(running.execution.dispatchCount,1);
  model.resolve();
  const complete=await terminal(f,request);
  assert.match(complete.result.markdown,/REPORT/);assert.equal(complete.result.savedReport.status,'pending');
  assert.equal((await f.rpc('generate-cancel',request)).cancelRequested,false);
  disk.reject(new Error('sensitive path'));const saved=await until(()=>f.rpc('progress',request),v=>v.savedReport?.status==='failed');
  assert.match(saved.savedReport.message,/不要重新生成/);assert.doesNotMatch(saved.savedReport.message,/sensitive/);
  assert.equal((await terminal(f,request)).result.savedReport.status,'failed');assert.equal(calls,1);
 }finally{model.resolve();disk.resolve({status:'saved',path:'/fixture/report.md'});}
});

test('real consent, route and capacity still gate the first dispatch; old backend epochs cannot replay',pick,async()=>{
 let calls=0,hostModel=false;
 const f=fixture({async *stream(){calls++;},resolveModelInfo:()=>hostModel?{context:{contextWindow:96000}}:null});
 const {request}=await f.request();
 for(const [change,code] of [[{sendToModel:false},'consent-required'],[{planId:'mismatch'},'plan-mismatch'],[{route:{...route,model:'other'}},'plan-mismatch']]){
  const rejected={...request,...change,operationId:randomUUID()};
  await f.rpc('generate-start',rejected);
  assert.equal((await terminal(f,rejected)).error.code,'code-report/'+code);
 }
 hostModel=true;
 await f.rpc('generate-start',request);
 assert.equal((await terminal(f,request)).error.code,'code-report/plan-mismatch');
 assert.equal(calls,0);
 const restarted=fixture({async *stream(){calls++;}});
 await assert.rejects(restarted.rpc('generate-start',request),{code:'code-report/backend-changed'});
 await assert.rejects(restarted.rpc('result',request),{code:'code-report/result-unavailable'});
 assert.equal(calls,0);
});

test('cancelled dispatched preview keeps callback checkpoint beyond initial expiry; retry requires fresh confirmation',pick,async()=>{
 const waiting=deferred(),entered=deferred(),ids=[];
 let first=true;
 const f=fixture({async *stream({id}){ids.push(id);if(id==='two'&&first){entered.resolve();await waiting.promise;}},
  async analyze(llm,r,s,{signal,plan,completed,onBatchComplete,onProgress}){
   for(const {id} of plan.batches){
    if(completed.has(id))continue;
    for await(const chunk of cancellableChunks(llm.stream({signal,id}),signal)){}
    completed.set(id,{});onBatchComplete(id,{});
    onProgress({phase:'analyzing',completed:completed.size,total:plan.batches.length});
   }
   return {markdown:'REPORT',completed};
  }
 });
 try{
  const {preview,request}=await f.request();await f.rpc('generate-start',request);await entered.promise;
  assert.equal((await f.rpc('progress',request)).execution.completedBatches,1);
  f.setClock(preview.expiresAt+100);
  const [initial,again]=await Promise.all([f.rpc('generate-cancel',request),f.rpc('generate-cancel',request)]);
  assert.equal(initial.cancelRequested,true);assert.equal(again.cancelRequested,false);
  const stopped=await terminal(f,request);
  assert.equal(stopped.execution.completedBatches,1);assert.equal(stopped.execution.dispatchCount,2);
  assert.equal(stopped.error.details.previewId,preview.previewId);assert.ok(stopped.error.details.previewExpiresAt>preview.expiresAt);
  assert.equal((await f.rpc('generate-start',request)).status,'stopped');
  const unconfirmed={...request,operationId:randomUUID(),sendToModel:false};await f.rpc('generate-start',unconfirmed);
  assert.equal((await terminal(f,unconfirmed)).error.code,'code-report/consent-required');
  first=false;waiting.resolve();
  const retry={...request,operationId:randomUUID()};await f.rpc('generate-start',retry);
  assert.equal((await terminal(f,retry)).status,'completed');assert.deepEqual(ids,['one','two','two','three','four']);
 }finally{waiting.resolve();}
});

test('global slots stay occupied by ignored cancellation until underlying iterators settle',pick,async()=>{
 let count=0;const held=deferred();
 const shared=async function*(){count++;await held.promise;};
 const analyze=async(llm,r,s,{signal,concurrency,onProgress})=>{
  onProgress({phase:'analyzing',inFlight:concurrency,queued:0,total:concurrency});
  await Promise.all(Array.from({length:concurrency},async()=>{for await(const chunk of cancellableChunks(llm.stream({signal}),signal)){};}));
  return {markdown:'REPORT'};
 };
 const a=fixture({stream:shared,analyze}),b=fixture({stream:shared,analyze});
 try{
  const first={...(await a.request()).request,concurrency:4},second={...(await b.request()).request,concurrency:2};
  await a.rpc('generate-start',first);await until(()=>count,v=>v===4);
  await a.rpc('generate-cancel',first);assert.equal((await terminal(a,first)).status,'stopped');
  await b.rpc('generate-start',second);
  const waiting=await until(()=>b.rpc('progress',second),v=>v.queued===2);
  assert.equal(waiting.inFlight,0);assert.equal(waiting.etaMs,null);assert.equal(count,4);
  held.resolve();assert.equal((await terminal(b,second)).status,'completed');assert.equal(count,6);
 }finally{held.resolve();}
});

test('admission abort removes queued work without dispatch after capacity becomes available',pick,async()=>{
 const held=deferred(),abort=new AbortController();let activeCalls=0,queuedCalls=0;
 const a=fixture({async *stream(){activeCalls++;await held.promise;},async analyze(llm,r,s,{signal}){
  await Promise.all(Array.from({length:4},async()=>{for await(const c of cancellableChunks(llm.stream({signal}),signal)){};}));
  return {markdown:'REPORT'};
 }});
 const b=fixture({async *stream(){queuedCalls++;},async analyze(llm,r,s,{signal,onProgress}){
  onProgress({phase:'analyzing',inFlight:1,queued:0,total:1});
  for await(const c of cancellableChunks(llm.stream({signal},{admissionSignal:abort.signal}),signal)){}
  return {markdown:'unexpected'};
 }});
 try{
  const first=(await a.request()).request,second=(await b.request()).request;
  await a.rpc('generate-start',first);await until(()=>activeCalls,v=>v===4);
  await b.rpc('generate-start',second);await until(()=>b.rpc('progress',second),v=>v.queued===1);
  abort.abort(new Error('peer failed'));
  assert.equal((await terminal(b,second)).execution.dispatchCount,0);
  held.resolve();await terminal(a,first);await tick();assert.equal(queuedCalls,0);
 }finally{held.resolve();abort.abort();}
});

test('single-request plan forces width one; saver is bounded without withholding reports',pick,async()=>{
 let requestedWidth,calls=0,writes=0;const disk=deferred();
 const f=fixture({async *stream(){calls++;},saveReport:()=>{writes++;return disk.promise;},
  async analyze(llm,r,s,{signal,concurrency}){requestedWidth=concurrency;for await(const c of llm.stream({signal})){}return {markdown:'REPORT'};}
 });
 try{
  const requests=[];
  for(let i=0;i<3;i++){
   const request={...(await f.request({strategy:'single-request'})).request,concurrency:4};requests.push(request);
   await f.rpc('generate-start',request);
   const result=await terminal(f,request);
   assert.match(result.result.markdown,/REPORT/);assert.equal(result.result.savedReport.status,i<2?'pending':'failed');
  }
  assert.equal(requestedWidth,1);assert.equal(calls,3);await until(()=>writes,v=>v===2);
  disk.resolve({status:'saved',path:'/fixture/report.md'});
  await until(()=>f.rpc('progress',requests[1]),v=>v.savedReport?.status==='saved');
 }finally{disk.resolve({status:'saved',path:'/fixture/report.md'});}
});

test('lifecycle publishes pending report then updates save notice without changing completion or replacing newer results',pick,async()=>{
 const model=deferred(),disk=deferred();const f=fixture({async *stream(){await model.promise;},saveReport:()=>disk.promise});
 try{
  const {request}=await f.request();const results=createResultStore(),calls=[];
  const lifecycle=createLifecycleController({rpc:(endpoint,...args)=>{calls.push(endpoint);return f.rpc(endpoint,...args);},results,randomId:()=>request.operationId,pollIntervalMs:1});
  const op=lifecycle.startGenerate(session,request,{asyncGenerate:true,backendInstanceId:request.backendInstanceId});
  await until(()=>lifecycle.getSnapshot().paid?.progress,v=>v?.phase==='analyzing');
  model.resolve();await op.promise;
  assert.equal(lifecycle.getSnapshot().lease,null);
  const completion=lifecycle.getSnapshot().lastCompleted;
  assert.equal(results.get(session).savedReport.status,'pending');
  disk.resolve({status:'saved',path:'/fixture/report.md'});
  await until(()=>lifecycle.getSnapshot().lastSavedReport,v=>v?.savedReport.status==='saved');
  assert.equal(results.getAnalysis(session).savedReport.path,'/fixture/report.md');
  assert.equal(lifecycle.getSnapshot().lastCompleted,completion);
  results.set(session,{markdown:'new',kind:'analysis',operationId:'new'});
  assert.equal(results.updateSavedReport(session,op.operationId,{status:'failed'}),false);
  assert.equal(results.get(session).markdown,'new');
  assert.deepEqual(calls.filter(call=>call.startsWith('generate')),['generate-start']);
 }finally{model.resolve();disk.resolve({status:'saved',path:'/fixture/report.md'});}
});

test('lost background admission does not fall back to generate or release an unknown lease',pick,async()=>{
 const calls=[],results=createResultStore();
 const lifecycle=createLifecycleController({rpc:async endpoint=>{calls.push(endpoint);throw new Error('lost');},results,randomId:()=> 'lost-op',pollIntervalMs:1});
 await lifecycle.startGenerate(session,{}, {asyncGenerate:true}).promise;await tick();
 assert.deepEqual(calls,['generate-start','result']);assert.equal(lifecycle.getSnapshot().paid.status,'unknown');
 assert.equal(results.getRecovery(session).operationId,'lost-op');assert.throws(()=>lifecycle.acquireBusiness('refs',session));
});
