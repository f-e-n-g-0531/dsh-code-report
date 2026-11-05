import test from 'node:test';
import assert from 'node:assert/strict';
import {reportDownloadText} from '../src/report-export.mjs';
const titles=['本次比较范围','改动内容','对外接口变更','影响范围','QA 测试范围'];
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
