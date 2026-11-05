import test from 'node:test';
import assert from 'node:assert/strict';
import {reportDownloadText} from '../src/report-export.mjs';
import {markdownText} from '../src/markdown-text.mjs';
import {renderReadableAnalysis} from '../src/readable-analysis.mjs';
const titles=['本次比较范围','改动内容','对外接口变更','影响范围','QA 测试范围'];

for(const escaped of [false,true])test('public endpoints survive source cleanup '+(escaped?'after markdownText':'as raw Markdown'),()=>{
 const endpoints=['https://api.example.com/v1/client.js','http://example.com/api.hpp?file=src/loader.cpp&next=/api/user.ts#result','/api/client.js','/v1/user.ts?file=src/api.cpp&mode=fast','//cdn.example.com/sdk.js','/api_user','https://example.com/get?q=(src/query.cpp)&next=public.js','/api?q=(src/query.cpp)&next=public.js'];
 const sources=['src/loader.cpp','D:\\private\\api.hpp','C3SkinInterface.h','src/my_api.ts'];
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
 assert.doesNotMatch(copy,/internal_api|internal[.]hpp|PRIVATE_SOURCE|SECRET_SOURCE|#evidence-|<details>|未知和待确认/);
 assert.doesNotMatch(copy,/https:\/\/|`https|&next=/); // Keep original inert entities, do not decode output.
 assert.deepEqual([...copy.matchAll(/^## (.*)$/gm)].map(match=>match[1]),titles);
 assert.ok(rendered.includes('SECRET_SOURCE'));
});
test('reader export contains exactly five ordered sections and no preamble or internal appendices',()=>{
 const original='# 标题\n模型：private\n## 本次比较范围\n项目A：版本a → b\n## 改动内容\n改动\n## 对外接口变更\n接口待确认\n## 影响范围\n- 功能 [1](#evidence-1)\n## QA 测试范围\n测试显示\n## 未知和待确认\nPRIVATE_UNKNOWN\n<details>\n<summary>技术附录：证据与覆盖记录</summary>\nSECRET_SOURCE\n</details>\n<details>\n<summary>采集附录：固定版本、完整文件清单与限制</summary>\nPRIVATE_PATH\n</details>';
 const copy=reportDownloadText(original,'analysis');assert.deepEqual([...copy.matchAll(/^## (.*)$/gm)].map(x=>x[1]),titles);assert.doesNotMatch(copy,/附录|SECRET_|PRIVATE_|#evidence-|模型：|# 标题/);assert.match(copy,/接口待确认/);assert.ok(original.includes('SECRET_SOURCE'));
});
test('local evidence and unknown results remain byte exact',()=>{for(const kind of ['local','unknown',undefined]){const text='a\r\n<details>raw';assert.equal(reportDownloadText(text,kind),text);}});
test('source paths, raw code blocks and nested details do not escape into the reader report',()=>{
 const input='## 改动内容\n删除 src/loader.cpp 和 C3SkinInterface.h；接口 Foo 和 /api_user 保留。\n路径 D:\\private\\api.hpp\n编码 src&#47;api.cpp\n```text\n## QA 测试范围\nRAW_CODE\n```\n<details>\n<summary>内部</summary>\n<details>\nSECRET\n</details>\n</details>\n## QA 测试范围\n测试功能';
 const copy=reportDownloadText(input,'analysis');assert.doesNotMatch(copy,/loader|SkinInterface|private|api[.]|RAW_CODE|SECRET|details/);assert.match(copy,/接口 Foo 和 \/api_user 保留/);assert.match(copy,/测试功能/);
});
test('missing sections are marked unknown rather than fabricated and unrelated headings close a section',()=>{const copy=reportDownloadText('## 影响范围\n待确认\n## 内部记录\nHIDDEN','analysis');assert.doesNotMatch(copy,/HIDDEN/);assert.equal(copy.match(/^## /gm).length,5);assert.match(copy,/未提供可对外展示的内容，待确认/);});
