import test from 'node:test';
import assert from 'node:assert/strict';
import {reportDownloadText} from '../src/report-export.mjs';
import {markdownText} from '../src/markdown-text.mjs';
import {renderReadableAnalysis} from '../src/readable-analysis.mjs';
import {markdown} from '../src/report.mjs';
const titles=['本次比较范围','对外接口变更','改动内容','QA 测试范围','待补充与待确认'];

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
 assert.doesNotMatch(copy,/internal_api|internal[.]hpp|PRIVATE(?:&#95;|_)SOURCE|SECRET_SOURCE|#evidence-|<details>|未知和待确认/);
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
 assert.doesNotMatch(copy,/本地清单含|117|已处理证据|附录|<details>/);
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

test('final polish moves QA gaps and preserves distinct steps',()=>{
 const input=['## QA 测试范围','### QA 可执行测试','- 登录 [1](#evidence-1)','  - 检查成功','- 登录 [2](#evidence-2)','  - 检查成功','- 登录','  - 检查错误提示','### 测试前待补充','- 补充测试账号','## 影响范围','不在正式报告','## 未知和待确认','- 补充测试账号','- 待确认兼容范围'].join('\n');
 const copy=reportDownloadText(input,'analysis');
 const [qa,gaps]=copy.split('## QA 测试范围')[1].split('## 待补充与待确认');
 assert.equal(qa.match(/^- 登录$/gm).length,2);
 assert.equal(qa.match(/检查成功/g).length,1);
 assert.match(qa,/检查错误提示/);
 assert.doesNotMatch(qa,/补充测试账号/);
 assert.equal(gaps.match(/补充测试账号/g).length,1);
 assert.match(gaps,/待确认兼容范围/);
 assert.doesNotMatch(copy,/不在正式报告|#evidence-/);
 assert.equal(reportDownloadText(copy,'analysis'),copy);
});
