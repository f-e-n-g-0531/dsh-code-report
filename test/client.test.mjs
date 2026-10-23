import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import React from 'react';
import {runtimeGate,PACKAGE_NAME,PROTOCOL_VERSION} from '../src/protocol.mjs';
import {captureBlocker} from '../src/result-state.mjs';
import {repositoryIssues,fresh,mergeRepositories} from '../src/repositories.mjs';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
// Test the current client in memory. This neither writes dist nor substitutes for browser tests.
const compiled=await build({entryPoints:['src/client.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react'],loader:{'.css':'text'}});
function harness(saved,{rpc=async()=>({ok:true,value:{packageName:PACKAGE_NAME,runningVersion:version,protocol:PROTOCOL_VERSION}})}={}){
 const states=[],refs=[],effects=[],registrations=[];let cursor=0,refCursor=0,effectCursor=0,Page;
 const hooks={...React,
  useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},
  useRef(value){const index=refCursor++;if(!refs[index])refs[index]={current:value};return refs[index];},
  useEffect(fn,deps){effects[effectCursor++]={fn,deps};}
 };
 const sandbox={module:{exports:{}},require:id=>{assert.equal(id,'react');return hooks;},localStorage:{getItem:()=>saved?JSON.stringify(saved):null},TextEncoder,crypto:webcrypto,AbortController,AbortSignal,Date,setTimeout,clearTimeout,setInterval,clearInterval};
 vm.runInNewContext(compiled.outputFiles[0].text,sandbox);
 sandbox.module.exports.apply({connection:{rpc:{call:rpc}},slots:{inject(_name,fn){fn();},register(options,component){registrations.push({options,component});if(options.name==='main')Page=component;}}});
 return {effects,registrations,render(){cursor=0;refCursor=0;effectCursor=0;const page=Page({useSessions:fn=>fn({byId:{s:{id:'s',cwd:'G:/one',retainedBy:{mainView:1}}}})});return page.type(page.props);}};
}
function nodes(tree){const all=[];function walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}all.push(node);walk(node.props?.children);}walk(tree);return all;}
test('business runtime gate rejects missing old foreign and incompatible hosts',()=>{
 const valid={packageName:PACKAGE_NAME,runningVersion:version,protocol:PROTOCOL_VERSION};assert.equal(runtimeGate(valid,version),'');
 for(const bad of [null,{...valid,runningVersion:'0.3.1'},{...valid,protocol:99},{...valid,packageName:'other'}])assert.ok(runtimeGate(bad,version));
});
test('panel restores SVN permission while model approval and active preview remain absent',()=>{
 const saved={schema:1,allowSvnNetwork:true,title:'上次发布',context:'client/api.ts',provider:'p',model:'m',scan:{maxDepth:20},rows:[{...fresh(),path:'client',type:'svn',a:'r1',b:'r2',branchA:'trunk',branchB:'release'}]};
 const all=nodes(harness(saved).render());
 assert.ok(all.some(node=>node.type==='input'&&node.props.value==='上次发布'));
 assert.equal(all.find(node=>node.type==='button'&&node.props.children==='扫描 / 重新发现').props.disabled,true);
 assert.equal(all.find(node=>node.type==='button'&&node.props.children==='开始执行 · 采集差异').props.disabled,true);
 assert.equal(all.find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,true);
 assert.equal(all.some(node=>node.props?.onGenerate),false);
});
test('capture blocker uses production pure state rules, including SVN permission',()=>{
 const git={...fresh(),path:'c3animation',a:'main',b:'HEAD'};
 const reason=(rows,network=false,busy='',compatibility='')=>captureBlocker(rows,network,busy,compatibility,repositoryIssues(rows));
 assert.match(reason([{...git,a:''}]),/c3animation.*Git A 分支/);
 assert.equal(reason([git]),'');assert.equal(reason([{...git,a:'',b:'',branchA:'main',branchB:'release'}]),'');
 const svn={...git,type:'svn',branchA:'trunk',branchB:'trunk'};
 assert.match(reason([svn]),/勾选允许读取 SVN/);assert.equal(reason([svn],true),'');assert.match(reason([git],false,'扫描项目'),/扫描项目/);assert.equal(reason([git],false,'','后台验证失败'),'后台验证失败');
});
test('discovery retains selected inputs and adds unselected projects',()=>{
 const before=[{...fresh(),path:'one',a:'main',b:'HEAD'}];
 const after=mergeRepositories(before,[{path:'two',type:'git'}]);
 assert.equal(after[0].a,'main');assert.equal(after[0].enabled,true);assert.equal(after[1].enabled,false);assert.equal(before.length,1);
});
test('automatic discovery effect starts once across verification unlocks',async()=>{
 let calls=0;
 const instance=harness(undefined,{rpc:async(_channel,endpoint)=>{
  if(endpoint==='runtime-info')return {ok:true,value:{packageName:PACKAGE_NAME,runningVersion:version,protocol:PROTOCOL_VERSION}};
  if(endpoint==='discover'){calls++;return {ok:true,value:{repositories:[],warnings:[],visited:1}};}
  throw new Error('unexpected '+endpoint);
 }});
 instance.render();
 const discovery=()=>instance.effects.find(item=>item.deps?.length===2&&item.deps[0]==='s');
 discovery().fn();assert.equal(calls,0);
 instance.effects.find(item=>item.deps?.length===1&&item.deps[0]===0).fn();
 await new Promise(resolve=>setImmediate(resolve));instance.render();
 discovery().fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 instance.render();discovery().fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});
test('client registers matching main/sidebar slots and uses active session identity',()=>{
 const instance=harness(),registrations=instance.registrations;
 assert.equal(registrations.length,2);assert.equal(registrations[0].options.key,registrations[1].options.id);
 assert.equal(registrations[1].options.order,66);assert.equal(registrations[1].options.label(),'发布报告');
 const page=registrations[0].component({useSessions:fn=>fn({byId:{s:{id:'s',cwd:'G:/one',retainedBy:{mainView:1}}}})});
 assert.equal(page.props.session.id,'s');
 const other=registrations[0].component({useSessions:fn=>fn({byId:{s:{id:'s',cwd:'G:/two',retainedBy:{mainView:1}}}})});
 assert.notEqual(page.key,other.key);
});
