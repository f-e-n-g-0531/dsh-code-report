import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {analyzeReport,createAnalysisPlan} from '../src/analysis.mjs';
import {markdown} from '../src/report.mjs';
import {reportDownloadText} from '../src/report-export.mjs';

const digest = text => createHash('sha256').update(text,'utf8').digest('hex');

async function renderFixture(strategy) {
  const file='include/api.h';
  const diff='diff --git a/'+file+' b/'+file+'\n--- a/'+file+'\n+++ b/'+file+'\n@@ -1 +1 @@\n-int query();\n+int query(int flags);\n';
  const snapshot={title:'版本 & <摘要>',createdAt:'2026-01-01T00:00:00Z',repositories:[{path:'app',type:'git',a:'a',b:'b',files:[file],diff,summary:'',diffHash:digest(diff)}],publicApiPaths:[{repository:'app',path:'include/'}],context:[],limitations:['固定端点，未执行测试。']};
  const plan=createAnalysisPlan(snapshot,{strategy,inputBudget:64000});
  const route={provider:'fixture',model:'mock'};
  let calls=0;
  const llm={async *stream(input){
    calls++;
    const {evidence}=JSON.parse(input.messages[0].content[0].text);
    const changed=evidence.find(row=>row.provenance==='version-diff'&&row.text.includes('+int query('));
    assert.ok(changed);
    const evidenceIds=[changed.id];
    const qa=['QA｜P1｜查询；步骤：提交请求；预期：返回 & 结果。','QA｜P1｜查询；步骤：提交无效参数；预期：提示错误。','待补充｜账号；待补充：测试账号。','步骤：打开；预期：可见。','研发专项｜P2｜验证 ABI'].map(text=>({text,evidenceIds}));
    const result={changes:[{text:'更新查询参数。',evidenceIds}],interfaces:[{text:'query 新增 flags。',evidenceIds,symbol:'query',declarationEvidenceIds:evidenceIds,audience:'sdk-candidate',publicBasis:null}],impacts:[],qa,unknowns:[{text:'兼容性待确认。',evidenceIds}],evidenceDispositions:evidence.filter(item=>item.id!==changed.id).map(item=>({evidenceId:item.id,status:'no-conclusion',reasonCode:'non-behavioral',reason:'元数据'}))};
    yield {type:'text-delta',text:JSON.stringify(result)};
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  const result=await analyzeReport(llm,route,snapshot,{plan});
  assert.equal(calls,1);
  const report=reportDownloadText(markdown(snapshot,result.markdown,route,{structured:true,evidenceManifest:plan.coverage}),'analysis');
  assert.deepEqual([...report.matchAll(/^## (.*)$/gm)].map(match=>match[1]),['本次比较范围','对外接口变更','改动内容','QA 测试范围','待补充与待确认']);
  assert.match(report,strategy==='full'?/全量证据模式.*不代表语义完整/:/单次摘要.*不是全文语义分析/);
  assert.doesNotMatch(report,/固定端点，未执行测试|<details>|#evidence-|snapshotHash|payloadHash|SHA-256/);
  assert.match(result.markdown,/<a id="evidence-\d+"><\/a>/);
  assert.match(report,/SDK 候选接口（发布身份待确认）：query/);
  assert.match(report,/返回.*结果。/);
  assert.match(report,/提示错误。/);
  assert.match(report.split('## 待补充与待确认')[1],/测试账号/);
  return {internal:digest(result.markdown),formal:digest(report)};
}
// Internal Markdown includes evidence navigation; formal Markdown only retains reader scope notices.
const baseline = {
  full: {internal:'b8263cdd39bfd6e11fffc0788c901c5eb8e8863593eb841554a8d367b7efa91b',formal:'63b715efaded16da83c0c153ed0c3bf050ce8282f14d3df32c69ab8d51f86a78'},
  'single-request': {internal:'fadb5f67a0689eb955edd9fd4893359b1c59fababde27fd61a231f14e58914da',formal:'5b26a544e08f6c6ca5037e41a6526104271b41d953ef41b5bdeb7f349671bb6e'},
};
for (const [strategy, expected] of Object.entries(baseline)) {
  test(strategy+' report matches the expected internal and formal Markdown bytes', async () => {
    assert.deepEqual(await renderFixture(strategy), expected);
  });
}
