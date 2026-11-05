import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['src/LazyDetails.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react']});
const sandbox={module:{exports:{}},require:()=>React};
vm.runInNewContext(compiled.outputFiles[0].text,sandbox);
const Details=sandbox.module.exports.default;
test('closed details never evaluates its expensive content factory',()=>{
 let calls=0;const html=renderToStaticMarkup(React.createElement(Details,{summary:'文件清单',className:'test'},()=>{calls++;return React.createElement('pre',null,'expensive content');}));
 assert.equal(calls,0);assert.equal(html,'<details class="test"><summary>文件清单</summary></details>');
});
