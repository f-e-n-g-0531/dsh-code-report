import test from 'node:test';
import assert from 'node:assert/strict';
import {ANALYSIS_SYSTEM,createAnalysisPlan,estimatedInputBytes} from '../src/analysis.mjs';

test('report instructions require observable QA cases and separate developer work without inventing entry points',()=>{
 for(const text of ['不读代码','QA｜P0/P1/P2｜具体功能场景标题','研发专项｜','待补充｜','禁止仅写P0｜','测试功能：','正常使用：','重点观察：','缺少具体入口','不虚构菜单','不把研发待确认约束写成已确定'])assert.ok(ANALYSIS_SYSTEM.includes(text),text);
});
test('QA scope describes normal product functions rather than developer adjustments',()=>{
 for(const text of ['功能回归范围，不是技术实验方案','测试【系统/对象】的【具体功能】','不强制凑详细步骤','QA不负责调材质或内部参数','由研发提供可直接使用的测试包','不自动丢掉已有证据支持的功能回归方向','不凭底层类名臆造'])assert.ok(ANALYSIS_SYSTEM.includes(text),text);
});
test('expanded QA guidance participates in plan identity and serialized input budget',()=>{
 const snapshot={title:'fixture',createdAt:'fixed',limitations:[],context:[],repositories:[{path:'app',type:'git',a:'a',b:'b',files:['a.h'],diff:'diff --git a/a.h b/a.h\n--- a/a.h\n+++ b/a.h\n@@ -1 +1 @@\n-old\n+new',summary:'a.h',diffHash:'hash'}]};
 const plan=createAnalysisPlan(snapshot,{strategy:'single-request',inputBudget:64000});
 assert.equal(plan.batches.length,1);for(const batch of plan.batches){assert.equal(batch.inputBytes,estimatedInputBytes(batch.snapshot));assert.ok(batch.inputBytes<=64000);}
});
