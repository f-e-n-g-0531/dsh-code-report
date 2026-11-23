import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnalysisPlan,analyzeReport} from '../src/analysis.mjs';
import {markdown} from '../src/report.mjs';
import {reportDownloadText} from '../src/report-export.mjs';
import {projectReportItems,renderTopic} from '../src/readable-analysis.mjs';
test('full report preserves scope and gaps with readable QA and numeric references',async()=>{
 const snapshot={title:'release',repositories:[{path:'app',type:'git',a:'a',b:'b',files:['api.h'],diff:['diff --git a/api.h b/api.h','--- a/api.h','+++ b/api.h','@@ -1 +1 @@','-old','+new',''].join(String.fromCharCode(10)),summary:'',diffHash:'hash'}],context:[],limitations:[],publicApiPaths:[{repository:'app',path:'sdk/'}]};
 const plan=createAnalysisPlan(snapshot,{inputBudget:64000});
 assert.deepEqual(plan.batches[0].snapshot.publicApiPaths,snapshot.publicApiPaths);
 const llm={async *stream(input){const {evidence,publicApiPaths}=JSON.parse(input.messages[0].content[0].text);assert.deepEqual(publicApiPaths,snapshot.publicApiPaths);yield {type:'text-delta',text:JSON.stringify({changes:[],interfaces:[],impacts:[],qa:[{text:'QA｜P1｜测试【对象】的显示功能；测试功能：显示；正常使用：打开；重点观察：缺失；回归边界：重复打开。',evidenceIds:[evidence[0].id]}],unknowns:[],evidenceDispositions:evidence.slice(1).map(item=>({evidenceId:item.id,status:'no-conclusion',reasonCode:'insufficient-context',reason:'未提供实现上下文，待确认。'}))})};yield {type:'finish',reason:{kind:'stop'}};}};
 const result=await analyzeReport(llm,{provider:'test',model:'mock'},snapshot,{plan});
 const internal=markdown(snapshot,result.markdown,{provider:'test',model:'mock'},{structured:true,evidenceManifest:plan.coverage});
 const copy=reportDownloadText(internal,'analysis');
 const links=[...internal.matchAll(/\[\d+\]\(#(evidence-\d+)\)/g)];
 assert.ok(links.length>0);
 for(const [,id] of links)assert.equal(internal.split('<a id="'+id+'"></a>').length,2);
 assert.match(internal,/分片覆盖与证据索引/);
 assert.match(copy,/全量证据模式.*不代表语义完整.*人工复核/);assert.match(copy,/### QA 可执行测试/);assert.match(copy,/测试功能/);assert.doesNotMatch(copy,/e-[a-f0-9]{32}|#evidence-|分片覆盖与证据索引/);
 if(result.coverage.noConclusion)assert.match(copy,/未提供实现上下文/);
});

test('validated report groups only explicit same-project topics and keeps original references and roles',()=>{
 const topic='【事项：资源通知撤销】';
 const item=(text,id)=>({text,evidenceIds:[id]});
 const section=extra=>({changes:[],interfaces:[],impacts:[],qa:[],unknowns:[],...extra});
 const candidate={...item(topic+'旧入口的二进制兼容性待确认。','decl'),symbol:'Remove',audience:'sdk-candidate'};
 const batches=[
  {evidence:[{id:'a',repository:'framework'},{id:'decl',repository:'framework'}],analysis:section({changes:[item(topic+'撤销只移除待发回调。','a')],interfaces:[candidate]})},
  {evidence:[{id:'b',repository:'framework'},{id:'x',repository:'engine'}],analysis:section({changes:[item(topic+'撤销只移除待发回调。','b')],impacts:[item(topic+'共享加载继续进行。','b'),item(topic+'其他项目仍保留独立入口。','x')],qa:[item(topic+'QA｜P1｜场景回归；重点观察：切场景后是否残留。','b'),item(topic+'待补充｜请提供失败样例。','b')],unknowns:[item('退出卡死风险待确认。','b')]})}
 ];
 const before=structuredClone(batches);
 const {items,movedSections}=projectReportItems(batches);
 assert.equal(items.changes.length,1);assert.ok(!movedSections.has('interfaces'));assert.ok(!movedSections.has('qa'));assert.equal(items.interfaces[0].symbol,'Remove');
 const text=renderTopic(items.changes[0],ids=>ids.join(',')).join('\n');
 assert.equal(text.match(/撤销只移除待发回调/g).length,1);assert.match(text,/撤销只移除待发回调。 a,b/);
 assert.doesNotMatch(text,/Remove|切场景/);assert.equal(items.impacts.length,2);
 assert.match(items.qa[0].text,/切场景/);assert.match(items.qa[1].text,/待补充/);assert.match(items.unknowns[0].text,/退出卡死风险/);assert.deepEqual(batches,before);
});

test('same-project reminders share a heading without losing distinct facts, projects or citations',()=>{
 const topic='【事项：资源加载】', note='请求受理不等于加载完成。';
 const item=(text,id)=>({text,evidenceIds:[id]});
 const batch=(repository,id,analysis)=>({evidence:[{id,repository}],analysis:{changes:[],interfaces:[],impacts:[],qa:[],unknowns:[],...analysis}});
 const first=batch('engine','a',{impacts:[item('【更新提醒】'+topic+note,'a')],changes:[item(topic+note,'a')]});
 const second=batch('engine','b',{impacts:[item('【更新提醒】'+topic+'失败时保持原画面。','b')],changes:[item(topic+note,'b')]});
 const third=batch('tools','c',{impacts:[item('【更新提醒】'+topic+note,'c')]});
 const before=structuredClone([first,second,third]);
 const {items}=projectReportItems([first,second,third]);
 assert.equal(items.impacts.length,2);assert.equal(items.impacts[0].details.length,2);assert.equal(items.impacts[1].details.length,1);
 assert.equal(items.changes.length,1);assert.deepEqual(items.changes[0].evidenceIds,['b']);
 assert.deepEqual([first,second,third],before);
});

for(const strategy of ['full','single-request']) test('reader export shows linked roles only once for '+strategy,async()=>{
 const snapshot={title:'release',repositories:[{path:'app',type:'git',a:'a',b:'b',files:['impl.cpp'],diff:'diff --git a/impl.cpp b/impl.cpp\n--- a/impl.cpp\n+++ b/impl.cpp\n@@ -1 +1 @@\n-old\n+new\n',summary:'',diffHash:'hash'}],context:[],limitations:[]};
 const plan=createAnalysisPlan(snapshot,{inputBudget:64000,strategy});
 let calls=0;const llm={async *stream(input){calls++;const {evidence}=JSON.parse(input.messages[0].content[0].text);const ids=evidence.map(e=>e.id);const tag='【事项：材质缓存包增量更新】';
  yield {type:'text-delta',text:JSON.stringify({changes:[{text:tag+'无新增时不改写旧包。',evidenceIds:ids},{text:tag+'归档校验后替换正式包。',evidenceIds:ids}],interfaces:[],impacts:[{text:'【更新提醒】'+tag+'无新增时不改写旧包。',evidenceIds:ids},{text:'【更新提醒】'+tag+'用旧包对照验证。',evidenceIds:ids}],qa:[{text:tag+'研发专项｜P1｜失败保护；重点观察：原包是否仍可用。',evidenceIds:ids}],unknowns:[{text:'恢复失败时能否保留备份待确认。',evidenceIds:ids}],evidenceDispositions:[]})};yield {type:'finish',reason:{kind:'stop'}};}};
 const result=await analyzeReport(llm,{provider:'test',model:'mock'},snapshot,{plan});
 const internal=markdown(snapshot,result.markdown,null,{structured:true,evidenceManifest:plan.coverage});const copy=reportDownloadText(internal,'analysis');
 assert.equal(calls,plan.batches.length);assert.equal(copy.match(/^## /gm).length,5);assert.equal(copy.match(/失败保护/g).length,1);
 assert.match(copy,/逐项改动明细/);assert.match(copy,/尚未执行/);assert.match(copy,/保留备份待确认/);
 const front=copy.split('## 对外接口变更')[0];
 assert.match(front,/材质缓存包增量更新[\s\S]*无新增时不改写旧包[\s\S]*用旧包对照验证/);
 assert.equal(copy.match(/无新增时不改写旧包/g).length,1);
 assert.match(copy.split('## 改动内容')[1],/归档校验后替换正式包/);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
 assert.doesNotMatch(copy,/#evidence-|impl.cpp|【事项/);assert.match(internal,/#evidence-/);
});
