import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/RepositoryCards.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react']});
const sandbox={module:{exports:{}},require:name=>{assert.equal(name,'react');return React;}};vm.runInNewContext(compiled.outputFiles[0].text,sandbox);
const Cards=sandbox.module.exports.default;
test('all project cards render collapsed with accessible controls and retained configuration',()=>{
 const rows=[{path:'client',type:'git',enabled:true,gitMode:'remote',gitRemote:'origin',a:'v1',b:'v2',branchA:'main',branchB:'release'},{path:'server',type:'svn',enabled:false,a:'10',b:'20',branchA:'trunk',branchB:'branches/release'}];
 const html=renderToStaticMarkup(React.createElement(Cards,{rows,scanState:'done'}));
 assert.equal((html.match(/data-expanded="false"/g)||[]).length,2);assert.equal((html.match(/aria-expanded="false"/g)||[]).length,2);assert.equal((html.match(/hidden=""/g)||[]).length,6);
 for(let index=0;index<rows.length;index++){const n=index+1;assert.ok(html.includes('aria-label="展开项目 '+n+'"'));assert.ok(html.includes('aria-controls="cr-project-config-'+index+' cr-project-a-'+index+' cr-project-b-'+index+'"'));assert.ok(html.includes('aria-label="纳入项目 '+n+'"'));assert.ok(html.includes('aria-label="移除项目 '+n+'"'));}
 for(const value of ['client','server','v1','v2','main','release','10','20','trunk','branches/release'])assert.ok(html.includes('value="'+value+'"'),value);
 assert.ok(html.includes('cr-project-name">client'));assert.ok(html.includes('cr-project-name">server'));
});
test('collapsed invalid project keeps visible error count and error-location action',()=>{const rows=[{path:'',type:'git',enabled:true,a:'',b:'',branchA:'',branchB:''}];const html=renderToStaticMarkup(React.createElement(Cards,{rows,scanState:'done'}));assert.ok(html.includes('定位首个错误项目'));assert.ok(html.includes('cr-project-error'));assert.ok(html.includes('未填写项目路径'));assert.ok(html.includes('data-expanded="false"'));});
