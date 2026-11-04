import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {createHandler} from '../src/host.mjs';

const snapshot=()=>({title:'async',createdAt:'fixed',repositories:[{path:'.',type:'git',a:'a'.repeat(40),b:'b'.repeat(40),requestedA:'main',requestedB:'develop',files:['api.js'],diff:'diff --git a/api.js b/api.js\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-old-private-body\n+new-private-body\n',summary:'api.js',diffHash:'hash'}],context:[],limitations:[]});
const payload=(operationId='capture',sessionId='s')=>({sessionId,operationId,request:{title:'release',repositories:[{path:'.',type:'git',branchA:'main',branchB:'develop'}],contextPaths:['source']}});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(capture){let calls=0,models=0,clock=1000;const signals=[];const sessions=new Map(['s','other','third'].map(id=>[id,{header:{cwd:'/workspace'}}]));const handler=createHandler({sessions,llm:{stream(){models++;throw new Error('model forbidden');}}},{capture:async(cwd,request,signal,update)=>{calls++;signals.push(signal);return capture?capture({cwd,request,signal,update}):snapshot();},now:()=>clock});return {handler,sessions,signals,calls:()=>calls,models:()=>models,setClock:value=>{clock=value;}};}
const poll=(f,id='capture',sessionId='s')=>f.handler('result',{sessionId,operationId:id});
async function terminal(f,id='capture'){for(let i=0;i<30;i++){const reply=await poll(f,id);if(!reply.ok||reply.value.status!=='pending')return reply;await turn();}throw new Error('capture did not settle');}

test('async capture acknowledges before even synchronous startup and recovers one public preview',async()=>{
 const gate=deferred(),f=fixture(async()=>{await gate.promise;return snapshot();}),input=payload();
 const started=await f.handler('preview-start',input);assert.deepEqual(started.value,{operationId:'capture',status:'pending'});assert.equal(f.calls(),0);
 assert.equal((await poll(f)).value.status,'pending');await turn();assert.equal(f.calls(),1);
 assert.equal((await f.handler('preview-start',input)).value.status,'pending');assert.equal(f.calls(),1);
 assert.equal((await f.handler('preview-start',payload('another'))).error.code,'code-report/busy');
 gate.resolve();const ready=await terminal(f);assert.equal(ready.value.status,'completed');const preview=ready.value.result;
 assert.ok(preview.previewId);assert.equal(preview.expiresAt,601000);assert.ok(preview.analysisPlan);assert.match(preview.markdown,/未调用模型/);
 assert.equal('diff' in preview.repositories[0],false);assert.ok(!JSON.stringify(ready).includes('new-private-body'));
 assert.equal((await f.handler('preview-start',input)).value.status,'completed');assert.deepEqual((await poll(f)).value.result,preview);assert.equal(f.calls(),1);assert.equal(f.models(),0);
});

test('transport abort after acknowledgement does not cancel server capture',async()=>{
 const gate=deferred(),transport=new AbortController(),f=fixture(async()=>{await gate.promise;return snapshot();});
 assert.equal((await f.handler('preview-start',payload(),transport.signal)).ok,true);transport.abort();await turn();
 assert.equal(f.signals[0].aborted,false);gate.resolve();assert.equal((await terminal(f)).value.status,'completed');assert.equal(f.models(),0);
});

test('explicit cancellation aborts owned capture and retains active lease until it settles',async()=>{
 const gate=deferred(),f=fixture(async()=>{await gate.promise;return snapshot();});await f.handler('preview-start',payload());await turn();
 assert.equal((await f.handler('preview-cancel',{sessionId:'other',operationId:'capture'})).ok,false);assert.equal(f.signals[0].aborted,false);
 const cancel=await f.handler('preview-cancel',{sessionId:'s',operationId:'capture'});assert.equal(cancel.value.cancelled,true);assert.equal(f.signals[0].aborted,true);assert.equal((await poll(f)).value.status,'pending');
 assert.equal((await f.handler('preview-start',payload('while-cancelling'))).error.code,'code-report/busy');
 gate.resolve();const stopped=await terminal(f);assert.equal(stopped.value.status,'stopped');assert.equal(stopped.value.error.code,'code-report/cancelled');assert.equal(stopped.value.execution.dispatchCount,0);assert.equal(stopped.value.result,undefined);
 assert.equal((await f.handler('preview-start',payload())).value.status,'stopped');assert.equal(f.calls(),1);assert.equal(f.models(),0);
});

test('same capture ID binds every input field and freezes request against caller mutation',async()=>{
 const gate=deferred();let captured;const f=fixture(async({request})=>{captured=request;await gate.promise;return snapshot();}),input=payload();
 await f.handler('preview-start',input);input.request.title='mutated';input.request.contextPaths.push('extra');
 assert.equal((await f.handler('preview-start',input)).error.code,'code-report/operation-conflict');
 for(const changed of [{...payload(),extra:true},{...payload(),request:{...payload().request,repositories:[{path:'changed'}]}},payload('capture','other')])assert.equal((await f.handler('preview-start',changed)).error.code,'code-report/operation-conflict');
 await turn();assert.equal(captured.title,'release');assert.deepEqual(captured.contextPaths,['source']);gate.resolve();assert.equal((await terminal(f)).value.status,'completed');assert.equal(f.calls(),1);
});

test('capture authority is revalidated before publication and result/cancel remain owned',async()=>{
 const gate=deferred(),f=fixture(async()=>{await gate.promise;return snapshot();});await f.handler('preview-start',payload());await turn();
 assert.equal((await poll(f,'capture','other')).ok,false);f.sessions.set('s',{header:{cwd:'/changed'}});
 assert.equal((await poll(f)).ok,false);assert.equal((await f.handler('preview-cancel',{sessionId:'s',operationId:'capture'})).ok,false);gate.resolve();await turn();await turn();
 f.sessions.set('s',{header:{cwd:'/workspace'}});const stopped=await terminal(f);assert.equal(stopped.value.status,'stopped');assert.equal(stopped.value.error.code,'code-report/session-changed');assert.equal(f.models(),0);
});

test('async tasks hold global active limit until completion and capture errors stay queryable',async()=>{
 const gate=deferred(),f=fixture(async()=>{await gate.promise;throw Object.assign(new Error('capture failure'),{code:'code-report/capture-failed'});});
 for(const [id,session] of [['one','s'],['two','other']])assert.equal((await f.handler('preview-start',payload(id,session))).ok,true);
 assert.equal((await f.handler('preview-start',payload('three','third'))).error.code,'code-report/busy');
 gate.resolve();for(const id of ['one','two']){let response;for(let i=0;i<30;i++){response=await poll(f,id,id==='one'?'s':'other');if(response.value.status==='stopped')break;await turn();}assert.equal(response.value.status,'stopped');assert.equal(response.value.error.code,'code-report/capture-failed');}
 assert.equal((await f.handler('preview-start',payload('four','third'))).ok,true);await turn();assert.equal(f.models(),0);
});

test('completed preview cancellation releases snapshot, while result TTL stays bounded',async()=>{
 const f=fixture();await f.handler('preview-start',payload());const ready=await terminal(f),preview=ready.value.result;
 assert.equal((await f.handler('preview-cancel',{sessionId:'s',operationId:'capture'})).value.status,'stopped');assert.equal((await poll(f)).value.status,'stopped');
 assert.equal((await f.handler('analysis-plan',{sessionId:'s',previewId:preview.previewId,inputBudget:64000})).error.code,'code-report/preview-expired');
 f.setClock(601001);assert.equal((await poll(f)).error.code,'code-report/result-unavailable');assert.equal(f.models(),0);
});

test('cancelling completed capture cannot discard a preview claimed by paid generation',async()=>{
 const gate=deferred(),entered=deferred();let models=0;
 const handler=createHandler({sessions:new Map([['s',{header:{cwd:'/workspace'}}]]),llm:{stream(){models++;throw new Error('model forbidden');}}},{capture:async()=>snapshot(),analyze:async()=>{entered.resolve();await gate.promise;return {markdown:'待确认',coverage:{}};}});
 const f={handler};await handler('preview-start',payload());const preview=(await terminal(f)).value.result;
 const generating=handler('generate',{sessionId:'s',operationId:'paid',previewId:preview.previewId,planId:preview.analysisPlan.id,route:{provider:'fixture',model:'none'},sendToModel:true});await entered.promise;
 assert.equal((await handler('preview-cancel',{sessionId:'s',operationId:'capture'})).error.code,'code-report/busy');
 assert.equal((await poll(f)).value.status,'completed');assert.equal((await poll(f,'paid')).value.status,'pending');
 gate.resolve();const generated=await generating;assert.equal(generated.ok,true);
 assert.equal((await handler('preview-cancel',{sessionId:'s',operationId:'capture'})).value.status,'stopped');
 assert.deepEqual((await poll(f,'paid')).value.result,generated.value);
 assert.equal((await handler('preview-cancel',{sessionId:'s',operationId:'paid'})).error.code,'code-report/input');assert.equal(models,0);
});

test('pre-cancelled start and cancelled session lookup cannot reserve or launch capture',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();assert.equal((await f.handler('preview-start',payload(),controller.signal)).ok,false);await turn();assert.equal(f.calls(),0);
 const gate=deferred(),transport=new AbortController();const handler=createHandler({sessions:new Map(),sessionPersistence:{stat:async()=>{await gate.promise;return {header:{cwd:'/workspace'}};}},llm:{}},{capture:async()=>{throw new Error('forbidden');}});
 const start=handler('preview-start',payload(),transport.signal);transport.abort();gate.resolve();assert.equal((await start).ok,false);assert.equal((await handler('result',{sessionId:'s',operationId:'capture'})).ok,false);
 assert.equal((await f.handler('runtime-info')).value.capabilities.asyncPreview,true);
});
