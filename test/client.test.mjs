import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
test('built client loads through DSH module loader and registers matching panel slots',async()=>{
 let entry;const source=await readFile(new URL('../dist/client.js',import.meta.url),'utf8');
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){entry=value;}}}});
 assert.equal(entry.id,'@feng0531/dsh-code-report');const plugin=entry.factory(id=>{assert.equal(id,'react');return React;});
 const registrations=[];plugin.apply({connection:{},slots:{inject(_name,fn){fn();},register(options,component){registrations.push({options,component});}}});
 assert.match(await readFile(new URL('../src/client.jsx',import.meta.url),'utf8'),/开始执行/);assert.match(source,/progress/);assert.equal(registrations[1].options.name,'sidebar.panellist');assert.equal(registrations[1].options.order,66);assert.equal(registrations.length,2);assert.equal(registrations[0].options.key,registrations[1].options.id);assert.equal(registrations[1].options.label(),'发布报告');
 let selected;const page=registrations[0].component({useSessions:selector=>{selected=selector({byId:{s:{id:'s',cwd:'/workspace',retainedBy:{mainView:1}}}});return selected;}});
 assert.equal(page.props.session.id,'s');
 const client=await readFile(new URL('../src/client.jsx',import.meta.url),'utf8');assert.ok(client.includes("setScanState(signal.aborted?'cancelled':'failed')"));assert.ok(client.includes('scanState={scanState}'));assert.ok(client.indexOf('{scanError&&')<client.indexOf('<RepositoryCards'));
 const css=await readFile(new URL('../src/style.css',import.meta.url),'utf8');assert.ok(css.includes('.cr-wide{width:100%;max-width:none;'));assert.ok(css.includes('.cr-root .cr-check{display:flex;'));
});
