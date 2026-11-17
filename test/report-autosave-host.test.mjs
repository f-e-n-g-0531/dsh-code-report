import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHandler} from '../src/host.mjs';
const route={provider:'fixture',model:'mock'};
for(const fails of [false,true])test('validated report autosave preserves paid result, replay and recovery: '+fails,async()=>{
 let saves=0,analyses=0;const cwd='/fixture/work';
 const h=createHandler({sessions:new Map([['s',{header:{cwd}}]])},{
 capture:async()=>({title:'report',repositories:[],context:[],limitations:[]}),
 plan:()=>({id:'plan',inputBudget:64000,batches:[],coverage:{}}),
 analyze:async()=>{analyses++;return {markdown:'## 改动内容\n完成',coverage:{}};},
 saveReport:async(root,text,{assertCurrent})=>{saves++;assert.equal(root,cwd);assert.match(text,/完成/);await assertCurrent();if(fails)throw new Error('private-path secret');return {status:'saved',path:cwd+'/dsh-code-report-reports/report.md'};}
 });
 const p=(await h('preview',{sessionId:'s',request:{}})).value;assert.equal(saves,0);
 const payload={sessionId:'s',operationId:randomUUID(),previewId:p.previewId,planId:p.analysisPlan.id,route,sendToModel:true,cwd:'/attacker'};
 const result=await h('generate',payload);assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.value.savedReport.status,fails?'failed':'saved');assert.ok(!JSON.stringify(result).includes('secret'));
 const replay=await h('generate',payload);assert.deepEqual(replay,result);assert.equal(saves,1);assert.equal(analyses,1);
 const recovery=await h('result',{sessionId:'s',operationId:payload.operationId});assert.deepEqual(recovery.value.result.savedReport,result.value.savedReport);
});
