import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifecycleController} from '../src/lifecycle-controller.mjs';
import {createResultStore} from '../src/result-state.mjs';
import {createUpdateController} from '../src/update-client.mjs';
const a={id:'a',cwd:'G:/a'},b={id:'b',cwd:'G:/b'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const execution={backendInstanceId:'host',dispatch:'dispatched',dispatchCount:1,resultAvailability:'unavailable',phase:'stopped'};
function setup(rpc){const results=createResultStore();let id=0;return {results,lifecycle:createLifecycleController({rpc,results,randomId:()=>String(++id)})};}
test('paid operation identity and atomic lease are registered before RPC; detached view is irrelevant',async()=>{
 const delivery=deferred();let observed;
 const {results,lifecycle}=setup((endpoint,payload)=>{observed={endpoint,payload,snapshot:lifecycle.getSnapshot()};return delivery.promise;});
 let notifications=0;const detach=lifecycle.subscribe(()=>notifications++);
 const operation=lifecycle.startGenerate(a,{planId:'plan',sendToModel:true});
 assert.equal(observed.snapshot.paid.operationId,operation.operationId);assert.equal(results.getRecovery(a).operationId,operation.operationId);
 detach();assert.throws(()=>lifecycle.acquireInstall());assert.throws(()=>lifecycle.acquireBusiness('refs',b));
 delivery.resolve({markdown:'paid A'});await operation.promise;
 assert.equal(results.get(a).markdown,'paid A');assert.equal(results.get(b),null);assert.equal(results.getRecovery(a),null);
 assert.equal(lifecycle.getSnapshot().lease,null);assert.ok(notifications>1);
});
test('explicit cancellation preserves unknown identity and reconciliation uses independent signal',async()=>{
 let signal,modelCalls=0,resultCalls=0;
 const {results,lifecycle}=setup((endpoint,payload,requestSignal)=>{
  if(endpoint==='generate'){modelCalls++;signal=requestSignal;return new Promise((resolve,reject)=>requestSignal.addEventListener('abort',()=>reject(new Error('abort'))));}
  resultCalls++;assert.equal(requestSignal.aborted,false);return {status:'pending',execution:{...execution,phase:'pending'}};
 });
 const operation=lifecycle.startGenerate(a,{});lifecycle.cancel(a);await operation.promise;
 assert.equal(signal.aborted,true);assert.equal(lifecycle.getSnapshot().paid.status,'unknown');assert.equal(results.getRecovery(a).operationId,operation.operationId);
 assert.throws(()=>lifecycle.acquireInstall());await lifecycle.recover(a);assert.equal(modelCalls,1);assert.equal(resultCalls,2);
});
test('all error prefixes require receipt and unavailable bodies never unlock paid lease',async()=>{
 for(const failure of [new Error('transport'),Object.assign(new Error('business'),{code:'code-report/request-failed'})]){
  let modelCalls=0;
  const {lifecycle}=setup(endpoint=>{if(endpoint==='generate'){modelCalls++;throw failure;}return {status:'unavailable',execution:{...execution,phase:'completed'}};});
  await lifecycle.startGenerate(a,{}).promise;
  assert.ok(lifecycle.getSnapshot().paid);assert.throws(()=>lifecycle.acquireBusiness('preview',b));assert.equal(modelCalls,1);
 }
});
test('structured stopped receipt unlocks with dispatch and billing warning, not free-retry inference',async()=>{
 const {lifecycle}=setup(endpoint=>{if(endpoint==='generate')throw new Error('lost');return {status:'stopped',execution,error:{message:'model stopped'}};});
 await lifecycle.startGenerate(a,{}).promise;
 assert.equal(lifecycle.getSnapshot().lease,null);assert.match(lifecycle.getSnapshot().lastFailure.message,/1.*模型派发.*计费/);
 const lease=lifecycle.acquireBusiness('refs',b);lease.release();
});
test('read-only recovery is allowed during ownership barrier and stores original-session report',async()=>{
 let completed=false,calls=0;
 const {lifecycle,results}=setup(endpoint=>{if(endpoint==='generate'){calls++;throw new Error('lost');}return completed?{status:'completed',result:{markdown:'recovered A'},execution:{...execution,resultAvailability:'available',phase:'completed'}}:{status:'pending',execution};});
 await lifecycle.startGenerate(a,{}).promise;
 await assert.rejects(lifecycle.recover(b),/此会话/);completed=true;await lifecycle.recover(a);
 assert.equal(results.get(a).markdown,'recovered A');assert.equal(results.get(b),null);assert.equal(calls,1);assert.equal(lifecycle.getSnapshot().paid,null);
});
test('business refs and installation race through the same synchronous atomic lease',async()=>{
 const {lifecycle}=setup(()=>{});const update=createUpdateController({lifecycle});
 const refs=lifecycle.acquireBusiness('refs',a);let installs=0;
 const info={latestVersion:'2.0.0',runningVersion:'1.0.0'},options={confirmed:true,clientVersion:'1.0.0'};
 await assert.rejects(update.install({installBundle(){installs++;}},info,options));assert.equal(installs,0);refs.release();
 const pending=deferred();const installing=update.install({installBundle(){installs++;return pending.promise;}},info,options);
 assert.throws(()=>lifecycle.acquireBusiness('refs',b));assert.throws(()=>lifecycle.startGenerate(b,{}));
 pending.resolve({ok:true,value:{application:'failed'}});await installing;
 const next=lifecycle.acquireBusiness('preview',b);next.release();assert.equal(installs,1);
});
test('unknown installation retains atomic barrier with no subscribers',async()=>{
 const {lifecycle}=setup(()=>{}),update=createUpdateController({lifecycle});
 await update.install({async installBundle(){throw new Error('lost');}},{latestVersion:'2.0.0',runningVersion:'1.0.0'},{confirmed:true,clientVersion:'1.0.0'});
 assert.equal(update.getSnapshot().outcome.state,'unknown');assert.throws(()=>lifecycle.acquireBusiness('refs',b));
});
test('abandoning a cancelled pending request never releases in-flight ownership',async()=>{
 const request=deferred();
 const {lifecycle,results}=setup(endpoint=>endpoint==='generate'?request.promise:{status:'pending',execution});
 const operation=lifecycle.startGenerate(a,{});lifecycle.cancel(a);lifecycle.abandon(a);
 assert.ok(lifecycle.getSnapshot().lease);assert.equal(results.getRecovery(a).operationId,operation.operationId);
 assert.match(lifecycle.getSnapshot().paid.message,/安全屏障继续保留/);
 assert.throws(()=>lifecycle.acquireInstall());assert.throws(()=>lifecycle.startGenerate(b,{}));
 request.reject(new Error('delivery stopped'));await operation.promise;
 assert.throws(()=>lifecycle.acquireInstall());assert.throws(()=>lifecycle.acquireBusiness('refs',b));
});
test('structured stopped error receipt unlocks even when result endpoint is unavailable',async()=>{
 let reads=0;
 const {lifecycle}=setup(endpoint=>{
  if(endpoint==='result'){reads++;throw new Error('offline');}
  throw Object.assign(new Error('input rejected'),{details:{execution:{...execution,dispatch:'not-dispatched',dispatchCount:0}}});
 });
 await lifecycle.startGenerate(a,{}).promise;
 assert.equal(reads,0);assert.equal(lifecycle.getSnapshot().lease,null);
 assert.match(lifecycle.getSnapshot().lastFailure.message,/尚无模型派发/);
});
test('unresolved identities are never silently removed by result-store LRU',()=>{
 const results=createResultStore({limit:1,maxBytes:10});
 for(let i=0;i<100;i++)results.setRecovery({id:String(i),cwd:'x'},{operationId:'op-'+i});
 results.set(a,{markdown:'x'.repeat(30)});assert.equal(results.getRecovery({id:'0',cwd:'x'}).operationId,'op-0');
});
