import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHandler} from '../src/host.mjs';
import {withDispositions} from './analysis-fixture.mjs';
test('replanning during capacity lookup cannot send an unconfirmed plan',async()=>{
 const route={provider:'p',model:'m'};let blocked=false,release,entered;const ready=new Promise(r=>entered=r);let calls=0;
 const llm={async resolveModelInfo(){if(blocked){blocked=false;entered();await new Promise(r=>release=r);}return {context:{contextWindow:1000000},defaultMaxTokens:32768};},async *stream(input){calls++;const p=JSON.parse(input.messages[0].content[0].text);yield {type:'text-delta',text:JSON.stringify(withDispositions({changes:[],interfaces:[],impacts:[],qa:[],unknowns:[]},p.evidence))};yield {type:'finish',reason:{kind:'stop'}};}};
 const snapshot={title:'race',repositories:[],context:[],limitations:[]};const h=createHandler({llm,agentDefaultModel:{currentSelection:()=>route},sessions:new Map([['s',{header:{cwd:'/w'}}]])},{capture:async()=>snapshot});
 const p=(await h('preview',{sessionId:'s',request:{}})).value;blocked=true;
 const pending=h('generate',{sessionId:'s',previewId:p.previewId,planId:p.analysisPlan.id,operationId:randomUUID(),route,sendToModel:true});await ready;
 const next=await h('analysis-plan',{sessionId:'s',previewId:p.previewId,route,inputBudget:64000});assert.equal(next.ok,true);release();
 const result=await pending;assert.equal(result.error.code,'code-report/plan-mismatch');assert.equal(calls,0);
});
