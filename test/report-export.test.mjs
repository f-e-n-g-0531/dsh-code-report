import test from 'node:test';
import assert from 'node:assert/strict';
import {reportDownloadText} from '../src/report-export.mjs';
import {markdownText} from '../src/markdown-text.mjs';
import {renderReadableAnalysis} from '../src/readable-analysis.mjs';
import {markdown} from '../src/report.mjs';
const titles=['本次比较范围','对外接口变更','QA 测试范围','待补充与待确认','改动内容'];

for(const escaped of [false,true])test('public endpoints survive source cleanup '+(escaped?'after markdownText':'as raw Markdown'),()=>{
 const endpoints=['https://api.example.com/v1/client.js','http://example.com/api.hpp?file=src/loader.cpp&next=/api/user.ts#result','/api/client.js','/v1/user.ts?file=src/api.cpp&mode=fast','//cdn.example.com/sdk.js','/api_user','https://example.com/get?q=(src/query.cpp)&next=public.js','/api?q=(src/query.cpp)&next=public.js'];
 const sources=['src/loader.cpp','D:\\private\\api.hpp','D:\\api.hpp','C3SkinInterface.h','src/my_api.ts'];
 const encode=escaped?markdownText:text=>text;
 const lines=[...endpoints.flatMap(endpoint=>[endpoint,'`'+endpoint+'`','[API]('+endpoint+')']),...sources.flatMap(source=>[source,'`'+source+'`']),endpoints[0]+'；源码 src/mixed_private.cpp 需清理。'];
 const copy=reportDownloadText('## 对外接口变更\n'+lines.map(text=>'- '+encode(text)).join('\n'),'analysis');
 for(const endpoint of endpoints)for(const text of [endpoint,'`'+endpoint+'`','[API]('+endpoint+')'])assert.ok(copy.includes('- '+encode(text)),text);
 for(const source of sources)for(const text of [source,'`'+source+'`'])assert.ok(!copy.includes('- '+encode(text)),text);
 assert.doesNotMatch(copy,/mixed_private/);
 assert.deepEqual([...copy.matchAll(/^## (.*)$/gm)].map(match=>match[1]),titles);
});

for(const escaped of [false,true])test('endpoint punctuation and adjacent inline spans do not protect unrelated source '+escaped,()=>{
 const encode=escaped?markdownText:text=>text;
 const text='[foo](/download/report.js),src/private_after_link.cpp；https://api.example.com/public.js,src/private_after_url.cpp；`公开 /api/user.js 和 src/private_in_prose.cpp`；`keep` `src/private_span.cpp` `also keep`';
 const copy=reportDownloadText('## 对外接口变更\n'+encode(text),'analysis');
 assert.ok(copy.includes(encode('[foo](/download/report.js)')));
 assert.ok(copy.includes(encode('https://api.example.com/public.js')));
 assert.ok(copy.includes(encode('`keep`')));assert.ok(copy.includes(encode('`also keep`')));
 assert.ok(copy.includes(encode('/api/user.js')));
 assert.doesNotMatch(copy,/private_after_link|private_after_url|private_in_prose|private_span/);
});

test('real readable-analysis rendering preserves escaped endpoint contracts without leaking source or appendices',()=>{
 const id='e-test';
 const endpoint='`https://api.example.com/client.js?file=src/private.cpp&next=/v1/user.ts`';
 const root='`/api/client.js?file=src/private.hpp&token=a_b`';
 const evidence={id,file:'src/PRIVATE_SOURCE.cpp',text:'SECRET_SOURCE',provenance:'version-diff'};
 const plan={strategy:'single-request',batches:[{id:'batch',evidenceIds:[id],snapshot:{evidence:[evidence]}}],coverage:{fullManifestFiles:1,sentFileCount:1,sentTextFileCount:1,omittedFileCount:0,total:1}};
 const analysis={changes:[{text:'修改 `src/internal_api.cpp` 和 D:\\private\\internal.hpp',evidenceIds:[id]}],interfaces:[{text:'公开 '+endpoint+' 以及 '+root+' 保持可调用。',evidenceIds:[id]}],impacts:[],qa:[],unknowns:[]};
 const rendered=renderReadableAnalysis(plan,new Map([['batch',{analysis}]]));
 const copy=reportDownloadText(rendered,'analysis');
 assert.ok(rendered.includes(markdownText(endpoint)));
 assert.ok(copy.includes(markdownText(endpoint)));assert.ok(copy.includes(markdownText(root)));
 assert.doesNotMatch(copy,/internal_api|internal[.]hpp|PRIVATE(?:&#95;|_)SOURCE|SECRET_SOURCE|#evidence-|技术附录|未知和待确认/);
 assert.doesNotMatch(copy,/https:\/\/|`https|&next=/); // Keep original inert entities, do not decode output.
 assert.deepEqual([...copy.matchAll(/^## (.*)$/gm)].map(match=>match[1]),titles);
 const [body,appendix]=rendered.split('\n<details>');
 assert.match(body,/\[1\]\(#evidence-1\)/);
 assert.doesNotMatch(body,/SECRET_SOURCE|PRIVATE(?:&#95;|_)SOURCE/);
 assert.match(appendix,/<a id="evidence-1"><\/a>/);
 assert.match(appendix,/SECRET_SOURCE/);
 assert.ok(appendix.includes(markdownText(evidence.file)));
});
test('reader export contains exactly five ordered sections and no preamble or internal appendices',()=>{
 const original='# 标题\n模型：private\n## 本次比较范围\n项目A：版本a → b\n## 改动内容\n改动\n## 对外接口变更\n接口待确认\n## 影响范围\n- 功能 [1](#evidence-1)\n## QA 测试范围\n测试显示\n## 未知和待确认\n- 测试入口尚待确认\n<details>\n<summary>技术附录：证据与覆盖记录</summary>\nSECRET_SOURCE\n</details>\n<details>\n<summary>采集附录：固定版本、完整文件清单与限制</summary>\nPRIVATE_PATH\n</details>';
 const copy=reportDownloadText(original,'analysis');assert.deepEqual([...copy.matchAll(/^## (.*)$/gm)].map(x=>x[1]),titles);assert.doesNotMatch(copy,/附录|SECRET_|PRIVATE_|#evidence-|模型：|# 标题/);assert.match(copy,/接口待确认/);assert.match(copy,/## 待补充与待确认\n\n- 测试入口尚待确认/);assert.ok(original.includes('SECRET_SOURCE'));
});
test('local evidence and unknown results remain byte exact',()=>{for(const kind of ['local','unknown',undefined]){const text='a\r\n<details>raw';assert.equal(reportDownloadText(text,kind),text);}});
test('source paths, raw code blocks and nested details do not escape into the reader report',()=>{
 const input='## 改动内容\n删除 src/loader.cpp 和 C3SkinInterface.h；接口 Foo 和 /api_user 保留。\n路径 D:\\private\\api.hpp\n编码 src&#47;api.cpp\n```text\n## QA 测试范围\nRAW_CODE\n```\n<details>\n<summary>内部</summary>\n<details>\nSECRET\n</details>\n</details>\n## QA 测试范围\n测试功能';
 const copy=reportDownloadText(input,'analysis');assert.doesNotMatch(copy,/loader|SkinInterface|private|api[.]|RAW_CODE|SECRET|details/);assert.match(copy,/接口 Foo 和 \/api_user 保留/);assert.match(copy,/测试功能/);
});
test('single summary coverage warning is retained in comparison scope without internal counts',()=>{
 const plan={strategy:'single-request',batches:[{id:'batch',evidenceIds:[],snapshot:{evidence:[]}}],coverage:{fullManifestFiles:120,sentFileCount:3,sentTextFileCount:2,omittedFileCount:117,total:0}};
 const analysis={changes:[],interfaces:[],impacts:[],qa:[],unknowns:[{text:'发布前仍需确认兼容性边界。',evidenceIds:[]}]};
 const copy=reportDownloadText(renderReadableAnalysis(plan,new Map([['batch',{analysis}]])),'analysis');
 const scope=copy.split('## 改动内容')[0];
 assert.match(scope,/单次摘要/);assert.match(scope,/预算内/);assert.match(scope,/不是全文语义分析/);assert.match(scope,/覆盖可能不完整/);assert.match(scope,/人工复核/);
 assert.match(copy,/发布前仍需确认兼容性边界/);
 assert.doesNotMatch(copy,/本地清单含|117|已处理证据|附录/);
 assert.deepEqual([...copy.matchAll(/^## (.*)$/gm)].map(match=>match[1]),titles);
});
for(const escaped of [false,true])test('unknowns retain meaning and safe encoding in the pending section without leaking source '+escaped,()=>{
 const encode=escaped?markdownText:text=>text;
 const endpoint='https://example.com/client.js?file=src/public.cpp&next=/api/test.ts';
 const input='## 本次比较范围\n'+encode('对比 src/scope.cpp 的版本')+'\n## 未知和待确认\n- '+encode('尚未确认 src/private.cpp 的兼容性；入口 '+endpoint+'；<script> & 中文😀')+' [1](#evidence-1)\n## 内部记录\nHIDDEN';
 const copy=reportDownloadText(input,'analysis');
 assert.match(copy,/## 待补充与待确认/);assert.match(copy,/尚未确认 相关源码文件 的兼容性/);
 assert.ok(copy.includes(encode(endpoint)));assert.ok(copy.includes(encode('<script> & 中文😀')));
 assert.match(copy,/对比 相关源码文件 的版本/);
 assert.doesNotMatch(copy,/private[.]cpp|scope[.]cpp|#evidence-|HIDDEN|^## 未知和待确认/m);
});
for(const escaped of [false,true])test('removed filenames leave readable neutral deletion sentences '+escaped,()=>{
 const encode=escaped?markdownText:text=>text;
 const sentence='删除 src/loader.cpp 与 C3SkinInterface.h；修改 \x60src/client.ts\x60 和 D:\\private\\api.hpp。';
 const copy=reportDownloadText('## 改动内容\n'+encode(sentence),'analysis');
 assert.match(copy,/删除 相关源码文件 与 相关源码文件；修改 相关源码文件 和 相关源码文件。/);
 assert.doesNotMatch(copy,/loader|SkinInterface|client|private|删除\s+与/);
 assert.equal(copy.match(/相关源码文件/g).length,4);
});
for(const strategy of ['full','single-request'])test('real report keeps collection limitations in the internal appendix, not formal scope '+strategy,()=>{
 const limitations=['大 diff 超过预算，src/private.cpp 未发送原文。','二进制文件未做语义分析。','上下文解码存在替换字符，需人工核对。','待核对 <script> & 中文😀；公开入口 https://example.com/client.js?file=src/public.cpp'];
 const snapshot={title:'发布比较',repositories:[{path:'project',type:'git',branchA:'old',branchB:'new',a:'aaa',b:'bbb',files:[],diffHash:'DIFF_HASH'}],context:[],limitations};
 const manifest={strategy,originalSourceBytes:100,fullManifestFiles:1,files:[{repository:'project',path:'src/APPENDIX_ONLY.cpp',status:'M',sentMetadata:true,sentText:true}]};
 const analysis={changes:[],interfaces:[],impacts:[],qa:[],unknowns:[]};
 const plan={strategy:'single-request',batches:[{id:'batch',evidenceIds:[],snapshot:{evidence:[]}}],coverage:{fullManifestFiles:1,sentFileCount:0,sentTextFileCount:0,omittedFileCount:1,total:0}};
 const body=strategy==='single-request'?renderReadableAnalysis(plan,new Map([['batch',{analysis}]])):
  '本次比较范围：全量证据模式；发送已纳入的差异证据，不代表语义完整。\n\n'+titles.slice(1).map(title=>'## '+title+'\n\n未提供业务结论。').join('\n\n');
 const original=markdown(snapshot,body,{provider:'private',model:'private'},{structured:true,evidenceManifest:manifest});
 const copy=reportDownloadText(original,'analysis'),scope=copy.split('## 改动内容')[0];
 assert.doesNotMatch(scope,/采集覆盖说明/);
 assert.doesNotMatch(scope,/大 diff 超过预算/);
 assert.doesNotMatch(scope,/二进制文件未做语义分析/);assert.doesNotMatch(scope,/上下文解码存在替换字符/);
 assert.doesNotMatch(scope,/待核对/);
 assert.doesNotMatch(scope,/模型输出为待人工复核/);
 assert.doesNotMatch(copy,/private[.]cpp|APPENDIX_ONLY|DIFF_HASH|附录|<details>|<script>|^模型：/m);
 assert.deepEqual([...copy.matchAll(/^## (.*)$/gm)].map(match=>match[1]),titles);
 const appendix=original.slice(original.indexOf('<summary>采集附录'));
 assert.doesNotMatch(original.split('<summary>采集附录')[0],/大 diff 超过预算|二进制文件未做语义分析|上下文解码存在替换字符/);
 assert.match(appendix,/## 覆盖范围与限制/);
 for(const limitation of limitations)assert.ok(appendix.includes(markdownText(limitation)));
 assert.match(appendix,/模型输出为待人工复核/);
 if(strategy==='single-request')assert.match(scope,/单次摘要.*覆盖可能不完整/);
 else assert.match(scope,/全量证据模式.*不代表语义完整.*人工复核/);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('legacy collection limitations under comparison scope are excluded without affecting real unknowns',()=>{
 const original='## 本次比较范围\n- project old → new\n### 采集覆盖限制（非业务结论）\n- DO_NOT_EXPORT\n本次比较范围：全量证据模式；发送已纳入的差异证据，不代表语义完整。\n## 未知和待确认\n- 契约仍待确认';
 const copy=reportDownloadText(original,'analysis');
 assert.match(copy,/project old → new/);
 assert.match(copy,/全量证据模式.*不代表语义完整/);
 assert.match(copy,/契约仍待确认/);
 assert.doesNotMatch(copy,/采集覆盖限制|DO_NOT_EXPORT/);
});
test('missing sections are marked unknown rather than fabricated and unrelated headings close a section',()=>{const copy=reportDownloadText('## 影响范围\n待确认\n## 内部记录\nHIDDEN','analysis');assert.doesNotMatch(copy,/HIDDEN/);assert.equal(copy.match(/^## /gm).length,5);assert.match(copy,/未提供可对外展示的内容，待确认/);});

test('reader export does not infer identical interfaces from byte-identical redacted text',()=>{
 const input='## 对外接口变更\n- SDK 候选接口：Load [1](#evidence-1)\n- SDK 候选接口：Load [2](#evidence-2)';
 const copy=reportDownloadText(input,'analysis');
 assert.equal(copy.match(/SDK 候选接口：Load/g).length,2);assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('client final polish groups explicit actions and folds only engine QA while retaining all risks',()=>{
 const input=['## 本次比较范围','- A → B','## 影响范围',
  '- 【换包后回归】首次进场检查角色是否漏显。','- 【换包前核对】配套库一起重编。','- 【换包前核对】配套库一起重编。',
  '- 【等引擎确认】旧包混用仍待确认。','- 未分类动作也要保留。','## 对外接口变更','- SDK 候选接口：Load',
  '## QA 测试范围','### QA 可执行测试','- 客户端返回场景','  - 观察残留','### 研发专项验证','- 验证备用导出 lib/src.cpp','  - 保留不同位宽检查',
  '### 测试前待补充','- 需提供实际版本包','## 未知和待确认','- 恢复失败可能删备份，待确认。','## 改动内容','- 保留原有行为。'].join('\n');
 const copy=reportDownloadText(input,'analysis');
 assert.doesNotMatch(copy,/^#### (?:换包前核对|换包后回归|等引擎确认)/m);
 assert.equal(copy.match(/配套库一起重编/g).length,1);assert.match(copy,/未分类动作也要保留/);assert.doesNotMatch(copy,/【换包|lib\/src\.cpp/);
 assert.match(copy,/<summary>研发专项验证（由引擎执行）<\/summary>[\s\S]*保留不同位宽检查/);
 assert.match(copy,/## 待补充与待确认[\s\S]*需提供实际版本包[\s\S]*恢复失败可能删备份/);
 assert.deepEqual([...copy.matchAll(/^## (.+)$/gm)].map(m=>m[1]),titles);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('identical action text in different stages stays under each stage after re-export',()=>{
 const input='## 影响范围\n'+['换包前核对','换包后回归','等引擎确认'].map(stage=>'- 【'+stage+'】核对相同的样例。').join('\n');
 const copy=reportDownloadText(input,'analysis');
 assert.equal(copy.match(/核对相同的样例。/g).length,3);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('private exclusion rules stay out of formal exports while the scope limitation remains visible',()=>{
 const snapshot={title:'release',repositories:[{path:'included-project',type:'git',a:'a',b:'b',files:[],scopeExclusions:[{path:'private-sandbox/case.txt',item:'D',directory:'private-sandbox/'}]}],limitations:[]};
 const internal=markdown(snapshot,'## 改动内容\n- 保留改动。',null,{structured:true,evidenceManifest:{files:[]}});
 assert.match(internal,/private-sandbox/);
 const copy=reportDownloadText(internal,'analysis');
 assert.match(copy,/部分变更已按本次范围设置排除/);assert.doesNotMatch(copy,/private-sandbox|按审查范围排除/);
 assert.match(copy,/included-project/);assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('older report heading is renamed without changing actual client program references',()=>{
 const input='## 本次比较范围\n### 客户端接入与影响\n- 旧客户端程序仍需验证。\n## 对外接口变更\n- SDK 候选接口：Load';
 const copy=reportDownloadText(input,'analysis');
 assert.match(copy,/### 更新后要注意什么[\s\S]*旧客户端程序仍需验证/);
 assert.doesNotMatch(copy,/### 客户端接入与影响|换包前，先核对/);assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('real conditions with an old workflow label are not removed',()=>{
 const input='## 本次比较范围\n### 使用方接入与影响\n- **换包前**：仅随包交付插件时核对兼容，锁版项目不适用。';
 const copy=reportDownloadText(input,'analysis');assert.match(copy,/仅随包交付插件时核对兼容，锁版项目不适用/);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('P0 engine checks remain visible in the release reader',()=>{
 for(const separator of ['｜','&#124;','&#65372;']){
  const copy=reportDownloadText('## QA 测试范围\n### 研发专项验证\n- 研发专项'+separator+'P0'+separator+'核对是否能启动。','analysis');
  assert.match(copy,/### P0 发布前优先核对[\s\S]*核对是否能启动/);assert.doesNotMatch(copy,/<details>/);
  assert.equal(reportDownloadText(copy,'analysis'),copy);
 }
});
test('shared rebuild instruction is shown once with distinct scopes and exceptions preserved',()=>{
 const input=['## 影响范围','- 【换包前核对】【成套重编】插件 A：核对旧回调。','- 【换包前核对】【成套重编】工具 B：仅在接入新接口时。','  - 不影响其他工具。','- 【换包前核对】锁版项目只需核对版本。'].join('\n');
 const copy=reportDownloadText(input,'analysis');
 assert.equal(copy.match(/成套重编与链接/g).length,1);assert.doesNotMatch(copy,/【成套重编】/);
 assert.match(copy,/^  - 插件 A：核对旧回调。$/m);assert.match(copy,/^  - 工具 B：仅在接入新接口时。$/m);
 assert.match(copy,/^    - 不影响其他工具。$/m);assert.match(copy,/^- 锁版项目只需核对版本。$/m);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('mixed specialist checks promote only P0, preserving children and idempotence',()=>{
 const copy=reportDownloadText(['## QA 测试范围','### QA 可执行测试','- 已接入场景','### 研发专项验证','- 研发专项｜P1｜普通检查','  - 普通步骤','- 研发专项&#124;P0&#124;有条件的阻断风险','  - 仅目标包使用时','- 研发专项｜P2｜另一个专项'].join('\n'),'analysis');
 const [visible,fold]=copy.split('<details>');
 assert.ok(visible.indexOf('有条件的阻断风险')<visible.indexOf('已接入场景'));assert.match(visible,/仅目标包使用时/);
 assert.doesNotMatch(visible,/普通检查|另一个专项/);assert.match(fold,/普通步骤[\s\S]*另一个专项/);
 assert.doesNotMatch(fold,/阻断风险/);assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('internal report cannot export lookalike folds and malformed roles stay visible',()=>{
 const input=['## 影响范围','- 【换包前核对】【成套重编】仅插件 A。','','  - 保留例外。','## QA 测试范围','### 研发专项验证','- QA｜P0｜检查场景','- 待补充｜缺少入口','- 研发专项｜P1｜核对实现','## 改动内容','- 改动：改动：改动：保留行为。','<details>','<summary>逐项改动明细</summary>','- PRIVATE_METADATA','</details>'].join('\n');
 const copy=reportDownloadText(input,'analysis',{source:'internal'});
 assert.match(copy,/仅插件 A。\n    - 保留例外/);assert.match(copy,/### 专项角色待核对[\s\S]*检查场景[\s\S]*缺少入口/);
 assert.doesNotMatch(copy,/PRIVATE_METADATA|改动：改动：/);assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('reader shows actual update reminders and conditional delivery risks before optional detail',()=>{
 const input=['## 本次比较范围','- 比较版本','## 影响范围','- 【换包前核对】核对 lib/secret.hpp 旧入口。','- 【更新提醒】模型加载：等待成功后再显示。','- 【换包后回归】检查模型是否漏显。','## 未知和待确认','- 【交付风险】仅当相关资源随包交付时，请引擎先证明能编译。','  - 使用替代资源时不适用。','- 旧库兼容待确认。','## 对外接口变更','- SDK 候选接口：Load','## 改动内容','- 保留相关改动。'].join('\n');
 const copy=reportDownloadText(input,'analysis',{source:'internal'});
 const [front,detail]=copy.split('<summary>查看其他接入与回归说明</summary>');
 assert.match(front,/更新后要注意什么[\s\S]*等待成功后再显示/);assert.doesNotMatch(front,/换包前|换包后|【更新提醒】/);assert.match(front,/仅当相关资源随包交付[\s\S]*不适用/);
 assert.doesNotMatch(front,/旧入口|模型是否漏显/);assert.match(detail,/旧入口[\s\S]*模型是否漏显/);
 assert.match(detail,/旧库兼容待确认/);assert.equal(copy.match(/仅当相关资源随包交付/g).length,1);
 assert.doesNotMatch(copy,/secret\.hpp|【交付风险】/);assert.equal(reportDownloadText(copy,'analysis'),copy);
});
test('final polish moves QA gaps without deduplicating evidence-free text',()=>{
 const input=['## QA 测试范围','### QA 可执行测试','- 登录 [1](#evidence-1)','  - 检查成功','- 登录 [2](#evidence-2)','  - 检查成功','- 登录','  - 检查错误提示','### 测试前待补充','- 补充测试账号','## 影响范围','接入时核对登录' ,'## 未知和待确认','- 补充测试账号','- 待确认兼容范围'].join('\n');
 const copy=reportDownloadText(input,'analysis');
 const [qa,gaps]=copy.split('## QA 测试范围')[1].split('## 待补充与待确认');
 assert.equal(qa.match(/^- 登录$/gm).length,3);
 assert.equal(qa.match(/检查成功/g).length,2);
 assert.match(qa,/检查错误提示/);
 assert.doesNotMatch(qa,/补充测试账号/);
 assert.equal(gaps.match(/补充测试账号/g).length,2);
 assert.match(gaps,/待确认兼容范围/);
 assert.match(copy.split('## 对外接口变更')[0],/更新后要注意什么[\s\S]*接入时核对登录/);assert.doesNotMatch(copy,/#evidence-/);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});

test('module grouping keeps same names in distinct projects and does not guess missing ownership',()=>{
 const evidence=[{id:'a',repository:'C3_Framework',text:'a'},{id:'b',repository:'c3animation',text:'b'}];
 const item=(label,text,evidenceIds)=>({text:'【模块：'+label+'】'+text,evidenceIds});
 const analysis={
  changes:[item('动画预览','框架改动。',['a']),item('动画预览','动画库改动。',['b']),item('动画预览','成套交付。',['a','b']),item('私有目录/secret.cpp','原条目仍保留。',['a'])],
  interfaces:[],impacts:[item('动画预览','框架使用提醒。',['a'])],qa:[item('动画预览','QA｜P1｜检查动画库；正常使用：从主窗口打开；回归边界：首次打开。',['b']),item('动画预览','QA｜P1｜检查动画库；正常使用：从重载入口打开；回归边界：已有旧预览。',['b'])],
  unknowns:[item('动画预览','没有证据的兼容性待确认。',[])],
 };
 const plan={strategy:'single-request',batches:[{id:'batch',evidenceIds:['a','b'],snapshot:{evidence}}],coverage:{total:2}};
 const copy=reportDownloadText(renderReadableAnalysis(plan,new Map([['batch',{analysis}]])),'analysis',{source:'internal'});
 const [,scope,interfaces,qa,pending,changes]=copy.split(/^## .+$/m);
 assert.deepEqual([...copy.matchAll(/^## (.+)$/gm)].map(match=>match[1]),titles);
 assert.match(scope,/#### C3&#95;Framework · 动画预览[\s\S]*框架使用提醒/);
 assert.doesNotMatch(scope,/检查动画库|框架改动/);
 assert.match(interfaces,/未列出对外接口变化，不保证完整覆盖/);
 assert.doesNotMatch(qa,/^#/m);
 assert.equal(qa.match(/QA｜P1｜检查动画库/g).length,2);
 assert.match(qa,/从主窗口打开[\s\S]*首次打开[\s\S]*从重载入口打开[\s\S]*已有旧预览/);
 assert.match(pending,/### 归属待确认[\s\S]*没有证据的兼容性待确认/);
 assert.match(changes,/### C3&#95;Framework[\s\S]*框架改动[\s\S]*其他事项（功能模块待确认）[\s\S]*原条目仍保留/);
 assert.match(changes,/### c3animation[\s\S]*动画库改动[\s\S]*### 跨项目联调[\s\S]*成套交付/);
 assert.match(changes,/^\s*<details>\n<summary>逐项改动明细<\/summary>\n\n### C3&#95;Framework[\s\S]*<\/details>\s*$/);
 assert.equal(changes.match(/<details>/g).length,1);
 assert.doesNotMatch(changes,/检查动画库|框架使用提醒/);
 assert.doesNotMatch(copy,/secret|【模块|code-report:/);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});

test('resource lifecycle aliases share one module per chapter and preserve individual entries',()=>{
 const marker=(repo,name)=>'<!-- code-report:group '+JSON.stringify(['repo',repo,name])+' -->';
 const group=name=>marker('sample-app',name);
 const input=['## 本次比较范围','- **sample-app**：A → B','<!-- code-report:modules-v1 -->',
  '## 影响范围',group('资源配置'),'- 不同配置证据 [1](#evidence-1)',group('资源加载'),'- 不同配置证据 [2](#evidence-2)',
  '## 对外接口变更',group('资源配置'),'- 查询路由保留。',group('资源加载'),'- 加载结果保留。',group('资源预加载'),'- 预加载寿命独立。',
  '## QA 测试范围','### QA 可执行测试',group('资源预加载'),'- QA｜P1｜测试资源操作。','  - 只触发预加载。',group('资源加载'),'- QA｜P1｜测试资源操作。','  - 等待实际加载结果。',marker('sample-tools','资源打包'),'- QA｜P2｜从工具验证打包。',
  '## 未知和待确认',group('资源配置'),'- 配置命中边界待确认。',group('资源加载'),'- 回调时机待确认。',
  '## 改动内容',group('资源配置'),'- 配置只查索引。',group('资源预加载'),'- 预加载不改配置。',group('资源加载'),'- 完成后发出通知。',
  group('资源打包'),'- 打包工具配置更新。',group('纹理加载'),'- 纹理后端更新。',marker('sample-tools','资源预加载'),'- 工具宿主行为独立。'].join('\n');
 const copy=reportDownloadText(input,'analysis',{source:'internal'});
 const [,scope,interfaces,qa,pending,changes]=copy.split(/^## .+$/m);
 assert.deepEqual([...copy.matchAll(/^## (.+)$/gm)].map(x=>x[1]),titles);
 assert.equal(scope.match(/^#### sample-app · 资源管理$/gm).length,1);
 assert.equal(scope.match(/不同配置证据/g).length,2);
 for(const chapter of [interfaces,pending])assert.equal(chapter.match(/^#### 资源管理$/gm).length,1);
 assert.match(interfaces,/查询路由保留[\s\S]*加载结果保留[\s\S]*预加载寿命独立/);
 assert.match(qa,/只触发预加载[\s\S]*等待实际加载结果/);assert.equal(qa.match(/QA｜P1｜测试资源操作/g).length,2);
 assert.match(qa,/^- QA｜P2｜从工具验证打包。$/m);assert.doesNotMatch(qa,/^#|sample-tools|sample-app/m);
 assert.match(pending,/配置命中边界待确认[\s\S]*回调时机待确认/);
 assert.equal(changes.match(/^#### 资源管理$/gm).length,2);
 assert.match(changes,/配置只查索引[\s\S]*预加载不改配置[\s\S]*完成后发出通知[\s\S]*#### 资源打包[\s\S]*#### 纹理加载[\s\S]*### sample-tools[\s\S]*工具宿主行为独立/);
 assert.doesNotMatch(copy,/^#### 资源(?:配置|加载|预加载)$/m);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});

test('modular QA uses explicit roles while keeping mixed items and their steps',()=>{
 const group='<!-- code-report:group ["repo","app","搜索"] -->';
 const input=['<!-- code-report:modules-v1 -->','## QA 测试范围','### 研发专项验证',group,'- QA&#124;P1&#124;打开主入口','  - 用现有输入查看结果',group,'- 待补充｜缺少样例','  - 由负责方提供',group,'- 研发专项&#65372;P0&#65372;核对构建','  - 仅核对目标环境','### 未分类测试建议（需人工确认执行角色与入口）',group,'- 无法判断执行角色','  - 需核对入口'].join('\n');
 const copy=reportDownloadText(input,'analysis',{source:'internal'});
 const [,,,,qaPending]=copy.split(/^## .+$/m);
 const qa=copy.split('## QA 测试范围')[1].split('## 待补充与待确认')[0];
 assert.match(qa,/打开主入口[\s\S]*查看结果/);
 assert.doesNotMatch(qa,/缺少样例|核对构建|无法判断执行角色/);
 assert.match(qaPending,/^\s*<details>\n<summary>查看待补充与待确认事项<\/summary>[\s\S]*<\/details>\s*$/);
 assert.match(qaPending,/缺少样例[\s\S]*由负责方提供[\s\S]*无法判断执行角色[\s\S]*需核对入口[\s\S]*核对构建[\s\S]*仅核对目标环境/);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});
