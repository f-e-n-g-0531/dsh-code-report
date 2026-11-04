import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const compiled=await build({entryPoints:['src/ReportDocument.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react']});
const sandbox={module:{exports:{}},require:name=>{assert.equal(name,'react');return React;}};
vm.runInNewContext(compiled.outputFiles[0].text,sandbox);
const {default:Document,decodeReportText}=sandbox.module.exports;
const render=markdown=>renderToStaticMarkup(React.createElement(Document,{markdown}));
test('reader never restores neutralized bidi controls',async()=>{const {markdownText}=await import('../src/markdown-text.mjs');for(const code of [...Array.from({length:5},(_,i)=>0x202a+i),...Array.from({length:4},(_,i)=>0x2066+i),0,8,11,12,31,127]){const safe=markdownText('api-'+String.fromCodePoint(code)+'fdp.exe'),decoded=decodeReportText(safe);assert.ok(!decoded.includes(String.fromCodePoint(code)));assert.ok(decoded.includes('&#'+code+';'));assert.ok(!render(safe).includes(String.fromCodePoint(code)));}});

test('generated headings, lists, inline identifiers, tables and local citations are readable',()=>{
 const html=render('# 发布报告\n\n## 对外接口变更\n\n- **中文&#95;接口** 使用 `request&#95;id` [1](#evidence-1)\n- 第二项\n\n1. 检查输入\n2. 验证结果\n\n| 接口 | 变化 |\n| --- | --- |\n| 新接口 | 新增 |\n\n<a id="evidence-1"></a>');
 for(const expected of ['<h1>发布报告</h1>','<h2>对外接口变更</h2>','<strong>中文_接口</strong>','<code>request_id</code>','<ul>','<ol>','<table>','href="#evidence-1"','id="evidence-1"'])assert.ok(html.includes(expected),expected);
 assert.ok(!html.includes('&amp;#95;'));
});
test('numeric entities decode only once as inert text; raw HTML, images and URLs never execute',()=>{
 const html=render('&#60;script&#62;alert(1)&#60;/script&#62;\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n![tracking](https://attacker.invalid/pixel)\n&#91;encoded&#93;&#40;javascript:alert(1)&#41;');
 assert.ok(!/<script|<img|onerror=|href="javascript:|src="https:/.test(html.replaceAll('onerror=alert(1)','literal-error')));
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;img'));
 assert.equal((html.match(/<a /g)||[]).length,0);
 assert.equal(decodeReportText('中文&#95;接口 &#x1f600;'),'中文_接口 😀');
 assert.equal(decodeReportText('&#38;#60;script&#62;'),'&#60;script>');
});
test('fenced code remains literal including encoded bytes and generated HTML delimiters',()=>{
 const tick=String.fromCharCode(96);
 const html=render(tick.repeat(4)+'diff\n# not heading\n<details>\n</details>\n&#95;literal\n'+tick.repeat(3)+'\n'+tick.repeat(4));
 assert.ok(html.includes('<pre><code>'));assert.ok(html.includes('# not heading'));assert.ok(html.includes('&lt;details&gt;'));
 assert.ok(!html.includes('<details'));assert.ok(html.includes('&amp;#95;literal'));
});
test('only exact generated details and summaries are recognized, and default closed',()=>{
 const html=render('## 发布结论\n\n正常正文\n\n<details>\n<summary>技术&#95;附录</summary>\n\n- 证据清单\n\n</details>\n\n<details open onclick="bad()">not trusted</details>');
 assert.ok(html.includes('<details class="cr-report-appendix"><summary>技术_附录</summary>'));
 assert.ok(html.includes('&lt;details open'));assert.ok(!html.includes('<details open'));
});
test('ordinary appendix headings never silently swallow subsequent report sections',()=>{
 const html=render('## 主要改动\n\n发布要点\n\n## 技术附录\n\n- 长哈希\n');
 assert.ok(html.includes('<h2>主要改动</h2>'));assert.ok(html.includes('<p>发布要点</p>'));
 assert.ok(html.includes('<h2>技术附录</h2>'));assert.ok(!html.includes('<details'));
});
