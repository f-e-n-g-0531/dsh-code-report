import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHandler} from '../src/host.mjs';
import {createLifecycleController} from '../src/lifecycle-controller.mjs';
import {createResultStore} from '../src/result-state.mjs';
const session={id:'s',cwd:'/workspace'};
const snapshot={title:'cancel',createdAt:'now',repositories:[],context:[],limitations:[]};
test('independent force cancel aborts hung model without relying on original transport, enforces ownership and preserves completion',async()=>{
 let entered;const ready=new Promise(r=>entered=r);let calls=0;
 const handler=createHandler({sessions:new Map([['s',{header:{cwd:session.cwd}}],['other',{header:{cwd:session.cwd}}]]),llm:{stream(){calls++;entered();return {next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{}),[Symbol.asyncIterator](){return this;}};}}},{capture:async()=>snapshot});
 const p=(await handler('preview',{sessionId:'s',request:{}})).value;const id=randomUUID();
 const running=handler('generate',{sessionId:'s',operationId:id,previewId:p.previewId,planId:p.analysisPlan.id,route:{provider:'p',model:'m'},sendToModel:true});await ready;
 assert.equal((await handler('generate-cancel',{sessionId:'other',operationId:id})).ok,false);
 const cancelled=await handler('generate-cancel',{sessionId:'s',operationId:id});assert.equal(cancelled.ok,true);assert.equal(cancelled.value.cancelRequested,true);assert.equal((await running).ok,false);
 const result=await handler('result',{sessionId:'s',operationId:id});assert.equal(result.value.status,'stopped');assert.equal(result.value.execution.dispatchCount,1);assert.equal(calls,1);
 assert.equal((await handler('generate-cancel',{sessionId:'s',operationId:id})).ok,true);
});
test('force cancellation immediately marks unknown, sends one independent request and never unlocks from acknowledgement',async()=>{
 let resolveCancel,resolveGenerate,cancels=0;const results=createResultStore();
 const lifecycle=createLifecycleController({results,randomId:()=>randomUUID(),rpc(endpoint,payload,signal){
  if(endpoint==='generate')return new Promise(r=>resolveGenerate=r);
  if(endpoint==='generate-cancel'){cancels++;assert.equal(signal.aborted,false);return new Promise(r=>resolveCancel=r);}
  return Promise.resolve({status:'pending'});
 }});
 const operation=lifecycle.startGenerate(session,{});const cancel=lifecycle.forceCancel(session);assert.equal(lifecycle.getSnapshot().paid.forceRequested,true);assert.equal(lifecycle.getSnapshot().paid.status,'unknown');assert.ok(lifecycle.getSnapshot().lease);
 assert.equal(lifecycle.forceCancel(session),cancel);assert.equal(cancels,1);assert.throws(()=>lifecycle.acquireBusiness('refs',session));
 resolveCancel({cancelRequested:true,status:'pending'});await cancel;assert.ok(lifecycle.getSnapshot().lease);assert.equal(results.getRecovery(session).operationId,operation.operationId);
 const retry=lifecycle.forceCancel(session);assert.equal(cancels,2);assert.equal(lifecycle.getSnapshot().paid.forceCancelling,true);resolveCancel({cancelRequested:true,status:'pending'});await retry;assert.ok(lifecycle.getSnapshot().lease);
 resolveGenerate({markdown:'completed despite cancel'});await operation.promise;assert.equal(results.get(session).markdown,'completed despite cancel');assert.equal(lifecycle.getSnapshot().lease,null);
});
