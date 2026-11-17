import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnalysisPlan,analyzeReport} from '../src/analysis.mjs';
import {markdown} from '../src/report.mjs';
import {reportDownloadText} from '../src/report-export.mjs';
test('full report preserves scope and gaps with readable QA and numeric references',async()=>{
 const snapshot={title:'release',repositories:[{path:'app',type:'git',a:'a',b:'b',files:['api.h'],diff:['diff --git a/api.h b/api.h','--- a/api.h','+++ b/api.h','@@ -1 +1 @@','-old','+new',''].join(String.fromCharCode(10)),summary:'',diffHash:'hash'}],context:[],limitations:[],publicApiPaths:[{repository:'app',path:'sdk/'}]};
 const plan=createAnalysisPlan(snapshot,{inputBudget:64000});
 assert.deepEqual(plan.batches[0].snapshot.publicApiPaths,snapshot.publicApiPaths);
 const llm={async *stream(input){const {evidence,publicApiPaths}=JSON.parse(input.messages[0].content[0].text);assert.deepEqual(publicApiPaths,snapshot.publicApiPaths);yield {type:'text-delta',text:JSON.stringify({changes:[],interfaces:[],impacts:[],qa:[{text:'QA｜P1｜测试【对象】的显示功能；测试功能：显示；正常使用：打开；重点观察：缺失；回归边界：重复打开。',evidenceIds:[evidence[0].id]}],unknowns:[],evidenceDispositions:evidence.slice(1).map(item=>({evidenceId:item.id,status:'no-conclusion',reasonCode:'insufficient-context',reason:'未提供实现上下文，待确认。'}))})};yield {type:'finish',reason:{kind:'stop'}};}};
 const result=await analyzeReport(llm,{provider:'test',model:'mock'},snapshot,{plan});
 const copy=reportDownloadText(markdown(snapshot,result.markdown,{provider:'test',model:'mock'},{structured:true,evidenceManifest:plan.coverage}),'analysis');
 assert.match(copy,/全量证据模式/);assert.match(copy,/处置覆盖不是语义完整性/);assert.match(copy,/### QA 可执行测试/);assert.match(copy,/测试功能/);assert.doesNotMatch(copy,/e-[a-f0-9]{32}|#evidence-|分片覆盖与证据索引/);
 if(result.coverage.noConclusion)assert.match(copy,/未提供实现上下文/);
});
