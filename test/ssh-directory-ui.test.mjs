import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import React from 'react';
import {build} from 'esbuild';
import {fresh,mergeRepositories,repositoryIssues} from '../src/repositories.mjs';
const compiled=await build({entryPoints:['src/RepositoryCards.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react']});
function nodes(tree){const all=[];function walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}all.push(node);walk(node.props?.children);}walk(tree);return all;}
function harness(row,loadRefs){
 let states=[],refs=[],effects=[],cursor=0,refCursor=0,effectCursor=0;
 const hooks={...React,useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},useRef(initial){const i=refCursor++;return refs[i]??=( {current:initial});},useEffect(fn,deps){const i=effectCursor++,previous=effects[i];if(!previous||deps.some((v,n)=>!Object.is(v,previous.deps[n])))effects[i]={fn,deps,pending:true};}};
 const sandbox={module:{exports:{}},require:()=>hooks,AbortController};vm.runInNewContext(compiled.outputFiles[0].text,sandbox);
 const cards=sandbox.module.exports.default({rows:[row]});
 const element=nodes(cards).find(node=>typeof node.type==='function');
 states=[];refs=[];effects=[];
 const changes=[];
 return {changes,render(next=row){cursor=refCursor=effectCursor=0;const tree=element.type({...element.props,row:next,expanded:true,loadRefs,change:(...args)=>changes.push(args)});for(const effect of effects)if(effect.pending){effect.pending=false;effect.fn();}return nodes(tree);}};
}
const button=all=>all.find(node=>node.type==='button'&&String(node.props.children).includes('读取远端'));
const sshInput=all=>all.find(node=>node.type==='input'&&node.props['aria-label']==='SSH 目录（可选） 1');
test('SSH directory defaults and discovery preserve each repository setting without mutation',()=>{
 assert.equal(fresh().sshDirectory,'');
 const previous=[{...fresh(),path:'one',sshDirectory:'G:/SSH keys'}];
 const merged=mergeRepositories(previous,[{path:'one',type:'git',sshDirectory:'wrong'},{path:'two',type:'git'}]);
 assert.equal(merged[0].sshDirectory,'G:/SSH keys');assert.equal(merged[1].sshDirectory,'');assert.notEqual(merged[0],previous[0]);
 const valid={...fresh(),a:'main',b:'release'};
 for(const sshDirectory of [undefined,'','G:/SSH keys','x'.repeat(2048)])assert.deepEqual(repositoryIssues([{...valid,sshDirectory}]),[]);
 for(const sshDirectory of [null,123,'x'.repeat(2049),'a\nb','a\0b','a\u007fb'])assert.match(repositoryIssues([{...valid,sshDirectory}]).join(' '),/SSH 目录/);
});
test('SSH directory input is remote Git only, accessible, and forwards edits',()=>{
 const row={...fresh(),sshDirectory:'G:/SSH keys'};const h=harness(row);let all=h.render();
 const input=sshInput(all);assert.equal(input.props.value,row.sshDirectory);assert.equal(input.props.maxLength,2048);
 const hint=all.find(node=>node.props?.id===input.props['aria-describedby']);assert.match(hint.props.children,/config、known_hosts.*默认身份文件.*留空.*现有 Git SSH/);
 input.props.onChange({target:{value:'G:/Other SSH'}});assert.deepEqual(h.changes,[[0,'sshDirectory','G:/Other SSH']]);
 assert.equal(sshInput(h.render({...row,gitMode:'local'})),undefined);
 assert.equal(sshInput(h.render({...row,type:'svn'})),undefined);
 assert.equal(sshInput(h.render({...row,sshDirectory:undefined})).props.value,'');
});
test('refs forwards SSH directory, clears loaded refs and errors, and aborts stale requests on change',async()=>{
 const row={...fresh(),sshDirectory:'G:/SSH one'};let mode='resolve',pending,signal,options;
 const h=harness(row,async(_path,s,o)=>{signal=s;options=o;if(mode==='fail')throw new Error('old failure');if(mode==='pending')return new Promise(resolve=>{pending=resolve;});return ['refs/heads/old'];});
 let all=h.render();await button(all).props.onClick();all=h.render();assert.equal(options.sshDirectory,row.sshDirectory);assert.equal(all.filter(n=>n.type==='option'&&n.props.value==='refs/heads/old').length,1);
 const next={...row,sshDirectory:'G:/SSH two'};h.render(next);all=h.render(next);assert.equal(all.filter(n=>n.type==='option'&&n.props.value==='refs/heads/old').length,0);
 mode='fail';await button(all).props.onClick();assert.ok(h.render(next).some(n=>n.props?.role==='alert'));
 const third={...row,sshDirectory:'G:/SSH three'};h.render(third);all=h.render(third);assert.equal(all.some(n=>n.props?.role==='alert'),false);
 mode='pending';const work=button(all).props.onClick();assert.equal(signal.aborted,false);
 h.render(row);assert.equal(signal.aborted,true);pending(['refs/heads/stale']);await work;
 assert.equal(h.render(row).some(n=>n.type==='option'&&n.props.value==='refs/heads/stale'),false);
});
