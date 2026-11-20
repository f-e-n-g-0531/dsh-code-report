import test from 'node:test';
import assert from 'node:assert/strict';
import {markdown,analyze} from '../src/report.mjs';
import {reportDownloadText} from '../src/report-export.mjs';

const context=[{path:'supplement/private-helper.ts',text:'SOURCE_INPUT_ONLY',hash:'CONTEXT_HASH_ONLY',rawHash:'RAW_CONTEXT_HASH_ONLY',encoding:'utf-8',provenance:'current-workspace'}];
const snapshot={title:'发布报告',createdAt:'now',repositories:[],context,limitations:['补充源码为当前工作区快照，不能证明历史版本。']};
const route={provider:'fixture',model:'mock'};

test('attached source inventories stay out of rendered and exported reports in all output modes',()=>{
 const before=JSON.stringify(snapshot);
 for(const entries of [[],context])for(const analysis of [undefined,'## 对外接口变更\n待确认'])for(const options of [{},{structured:true,evidenceManifest:{originalSourceBytes:0,fullManifestFiles:0,files:[]}}]){
  const output=markdown({...snapshot,context:entries},analysis,analysis?route:undefined,options);
  for(const text of [output,reportDownloadText(output,analysis?'analysis':'evidence')]){
   assert.doesNotMatch(text,/附带源码|未添加补充源码|private-helper|SOURCE_INPUT_ONLY|CONTEXT_HASH_ONLY/);
  }
  assert.doesNotMatch(output,/不能证明历史版本/);
  if(options.evidenceManifest)assert.doesNotMatch(reportDownloadText(output,analysis?'analysis':'evidence'),/不能证明历史版本/);
 }
 assert.equal(JSON.stringify(snapshot),before);
});

test('attached source remains available to model analysis without changing its snapshot',async()=>{
 const before=JSON.stringify(snapshot);let calls=0;
 const llm={async *stream(input){calls++;assert.deepEqual(JSON.parse(input.messages[0].content[0].text).context,context);yield {type:'text-delta',text:'## 对外接口变更\n待确认'};yield {type:'finish',reason:{kind:'stop'}};}};
 await analyze(llm,route,snapshot);assert.equal(calls,1);assert.equal(JSON.stringify(snapshot),before);
});
