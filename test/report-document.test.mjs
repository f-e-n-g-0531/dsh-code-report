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
// Drive component-local hooks without a DOM dependency. Nested components rendered
// through SSR still use real React hooks and default to their own closed state.
function componentHarness(){
 let active=null;
 const runtime={...React,
  useState(initial){if(!active)return React.useState(initial);const frame=active,index=frame.index++;if(!(index in frame.slots))frame.slots[index]=initial;return [frame.slots[index],value=>{frame.slots[index]=value;}];},
  useMemo(factory,deps){if(!active)return React.useMemo(factory,deps);const frame=active,index=frame.index++,previous=frame.slots[index];if(previous&&deps.length===previous.deps.length&&deps.every((value,n)=>Object.is(value,previous.deps[n])))return previous.value;const value=factory();frame.slots[index]={deps,value};return value;}
 };
 const scope={module:{exports:{}},require:name=>{assert.equal(name,'react');return runtime;}};
 vm.runInNewContext(compiled.outputFiles[0].text,scope);
 return {Document:scope.module.exports.default,instance(Component){const frame={slots:[],index:0};return props=>{active=frame;frame.index=0;try{return Component(props);}finally{active=null;}};}};
}
const children=element=>React.Children.toArray(element.props.children);
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
 assert.ok(!html.includes('证据清单'));assert.ok(!html.includes('<ul>'));
});
test('appendix bodies parse only on expansion and are removed on collapse',()=>{
 const harness=componentHarness(),document=harness.instance(harness.Document.type);
 const article=document({markdown:'<details>\n<summary>Evidence</summary>\n\n# Lazy heading\n\n- body\n\n<details>\n<summary>Nested</summary>\n\nNested body\n\n</details>\n</details>\n\n## Following section'});
 const [appendix,following]=children(article),instance=harness.instance(appendix.type);
 assert.equal(following.type,'h2');
 let reads=0;
 const lines=new Proxy(appendix.props.lines,{get(target,key){reads++;return Reflect.get(target,key);}}),props={...appendix.props,lines};
 let view=instance(props);
 assert.equal(view.props.open,false);assert.equal(reads,0);assert.equal(children(view).length,1);
 view.props.onToggle({currentTarget:{open:true}});view=instance(props);
 assert.equal(view.props.open,true);assert.ok(reads>0);
 const html=renderToStaticMarkup(view);
 assert.ok(html.includes('<h1>Lazy heading</h1>'));assert.ok(html.includes('<li>body</li>'));
 assert.ok(html.includes('<summary>Nested</summary>'));assert.ok(!html.includes('Nested body'));
 const parsed=view.props.children[1],nested=parsed.find(element=>typeof element.type==='function');
 const nestedInstance=harness.instance(nested.type);let nestedView=nestedInstance(nested.props);
 nestedView.props.onToggle({currentTarget:{open:true}});nestedView=nestedInstance(nested.props);
 assert.ok(renderToStaticMarkup(nestedView).includes('<p>Nested body</p>'));
 reads=0;assert.equal(instance(props).props.children[1],parsed);assert.equal(reads,0);
 view.props.onToggle({currentTarget:{open:false}});view=instance(props);
 assert.equal(view.props.open,false);assert.equal(children(view).length,1);assert.equal(reads,0);
 view.props.onToggle({currentTarget:{open:true}});assert.ok(renderToStaticMarkup(instance(props)).includes('Lazy heading'));
});
test('expanded appendix preserves markdown, literal fences and inert unsafe syntax',()=>{
 const harness=componentHarness(),document=harness.instance(harness.Document.type),tick=String.fromCharCode(96);
 const body=['## Evidence','', '- **safe&#95;name** '+tick+'api&#95;id'+tick+' [1](#evidence-1)','', '1. ordered','', '| Key | Value |','| --- | --- |','| a | b |','', '<a id="evidence-1"></a>','', '&#60;script&#62;alert(1)&#60;/script&#62;','<img src=x onerror=bad()>','[bad](javascript:alert(1))','![pixel](https://attacker.invalid/pixel)','&#8238;','', tick.repeat(3)+'diff','</details>','<details>','&#95;literal',tick.repeat(3)].join('\n');
 const article=document({markdown:'<details>\n<summary>Appendix</summary>\n\n'+body+'\n</details>\n\n## After'});
 const [appendix,after]=children(article),instance=harness.instance(appendix.type);
 assert.equal(after.type,'h2');let view=instance(appendix.props);view.props.onToggle({currentTarget:{open:true}});view=instance(appendix.props);
 const html=renderToStaticMarkup(view);
 for(const expected of ['<h2>Evidence</h2>','<strong>safe_name</strong>','<code>api_id</code>','href="#evidence-1"','id="evidence-1"','<ol>','<table>','<pre><code>&lt;/details&gt;','&amp;#95;literal','&lt;script&gt;','&lt;img','&amp;#8238;'])assert.ok(html.includes(expected),expected);
 assert.ok(!/<script|<img|href="javascript:|src="https:/.test(html));assert.ok(!html.includes(String.fromCodePoint(8238)));
});
test('unchanged markdown reuses parsed blocks and changed markdown invalidates them',()=>{
 const harness=componentHarness(),document=harness.instance(harness.Document.type);
 assert.equal(harness.Document.$$typeof,Symbol.for('react.memo'));
 const first=document({markdown:'# Original'}),same=document({markdown:'# Original'}),changed=document({markdown:'# Updated'});
 assert.equal(first.props.children,same.props.children);assert.notEqual(first.props.children,changed.props.children);
 assert.ok(renderToStaticMarkup(changed).includes('<h1>Updated</h1>'));
});
test('ordinary appendix headings never silently swallow subsequent report sections',()=>{
 const html=render('## 主要改动\n\n发布要点\n\n## 技术附录\n\n- 长哈希\n');
 assert.ok(html.includes('<h2>主要改动</h2>'));assert.ok(html.includes('<p>发布要点</p>'));
 assert.ok(html.includes('<h2>技术附录</h2>'));assert.ok(!html.includes('<details'));
});
