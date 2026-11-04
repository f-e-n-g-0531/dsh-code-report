import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

// Compile the real UI in memory. No dist changes, browser substitute or model call.
const source=await readFile('src/client.jsx','utf8');
const built=await build({stdin:{contents:source+'\nexport {PreviewSection,ReportSection};',resolveDir:process.cwd()+'/src',loader:'jsx'},bundle:true,write:false,format:'cjs',platform:'browser',external:['react'],loader:{'.css':'text'}});
const sandbox={module:{exports:{}},require:name=>{assert.equal(name,'react');return React;}};
vm.runInNewContext(built.outputFiles[0].text,sandbox);
const {PreviewSection,ReportSection}=sandbox.module.exports;
const coverage={strategy:'single-request',originalSourceBytes:369000000,fullManifestFiles:1250,sentFileCount:17,sentTextFileCount:9,omittedFileCount:1233,generatedFileCount:211};
const preview={expiresAt:1000000,bytes:369000000,repositories:[{path:'app',type:'git',a:'sha-a',b:'sha-b',files:['a.ts'],gitSource:'local'}],context:[],limitations:[],analysisPlan:{strategy:'single-request',batches:[{id:'summary'}],coverage}};
function renderPreview(overrides={}){return renderToStaticMarkup(React.createElement(PreviewSection,{preview,now:1,provider:'provider',model:'model',consent:false,inputBudget:'64000',budgetValid:true,...overrides}));}
test('single-request preview separates complete local statistics from partial model input',()=>{
 const html=renderPreview();
 for(const text of ['单次输入预算','单次摘要分析 · 非模型全文覆盖','本地完整统计','369000000','1250','17','1233','211','已发送文件也不代表其全文已发送','一次模型请求','失败不会自动重试','一次请求可能计费'])assert.ok(html.includes(text),text);
 assert.ok(html.includes('实际发送正文片段 9 个'));assert.ok(html.includes('完全未发送文件专属证据 1233 个'));assert.ok(html.includes('非原始网络字节'));
 assert.ok(html.includes('aria-label="单次输入预算"'));assert.ok(html.includes('min="4000"'));assert.ok(html.includes('max="64000"'));
 assert.ok(!html.includes('分批调用可能多次计费'));assert.ok(!html.includes('按顺序调用模型'));
 assert.match(html,/<input type="checkbox"\s*\/>/);
});
test('legacy plan without strategy retains explicit multi-batch consent, not summary claims',()=>{
 const html=renderPreview({preview:{...preview,analysisPlan:{batches:[{id:'one'},{id:'two'}],coverage:{total:2}}}});
 assert.ok(html.includes('单片输入预算'));assert.ok(html.includes('本计划 2 片'));
 assert.ok(html.includes('分批调用可能多次计费'));assert.ok(!html.includes('单次摘要分析 · 非模型全文覆盖'));
});
test('single-request result coverage cannot label digest evidence as full source analysis',()=>{
 const html=renderToStaticMarkup(React.createElement(ReportSection,{result:{markdown:'report',coverage:{...coverage,total:8,processed:8,remaining:0,completedBatches:1,totalBatches:1,cited:2}}}));
 assert.ok(html.includes('已处理摘要证据 8 / 8'));assert.ok(html.includes('非模型全文覆盖'));assert.ok(html.includes('未发送的正文无法据此宣称已分析'));
 assert.ok(html.includes('引用有效不代表结论正确'));assert.ok(html.includes('本地差异文本字节 369000000'));
});
test('missing digest statistics are disclosed, never presented as zero/full coverage',()=>{
 const html=renderPreview({preview:{...preview,analysisPlan:{strategy:'single-request',batches:[{id:'one'}]}}});
 assert.ok(html.includes('本地差异文本字节 未提供'));assert.ok(html.includes('完整文件清单 未提供 个'));
});
