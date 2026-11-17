import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadWorkspaceConfiguration as load,saveWorkspaceConfiguration as save,WORKSPACE_CONFIGURATION_FILENAME as filename} from '../src/workspace-configuration.mjs';
import {cleanConfiguration} from '../src/configuration.mjs';
import {fresh} from '../src/repositories.mjs';
import {apply} from '../index.mjs';
import {RPC_CHANNEL} from '../src/protocol.mjs';
const config=()=>({schema:1,title:'发布报告',context:'src/',provider:'p',model:'m',rows:[{...fresh(),sshDirectory:'G:/keys/id_ed25519'}]});
async function workspace(t){const cwd=await mkdtemp(path.join(tmpdir(),'report-config-'));t.after(()=>rm(cwd,{recursive:true,force:true}));return cwd;}
const code=suffix=>({code:'code-report/configuration-'+suffix});

test('workspace file round-trip uses the fixed root filename and a whitelist, never secrets or confirmations',async t=>{
 const cwd=await workspace(t);assert.equal(await load(cwd),null);
 const source={...config(),password:'secret-password',apiKey:'secret-key',consent:true,sendToModel:true,privateKey:'secret-key-content',rows:[{...config().rows[0],password:'row-password',privateKey:'row-key'}]};
 const expected=cleanConfiguration(source);assert.deepEqual(await save(cwd,source),expected);
 assert.deepEqual(await readdir(cwd),[filename]);const raw=await readFile(path.join(cwd,filename),'utf8');
 assert.doesNotMatch(raw,/secret-password|secret-key|row-password|row-key|consent|sendToModel|privateKey|password|apiKey/);
 assert.equal(JSON.parse(raw).rows[0].sshDirectory,'G:/keys/id_ed25519');assert.deepEqual(await load(cwd),expected);
 await save(cwd,{...config(),title:'replacement'});assert.equal((await load(cwd)).title,'replacement');
});
test('invalid saves preserve the existing file and parse errors do not reveal file contents',async t=>{
 const cwd=await workspace(t),target=path.join(cwd,filename);await save(cwd,config());const prior=await readFile(target,'utf8');
 for(const value of [null,{...config(),schema:2},{...config(),rows:[{...fresh(),gitRemote:'https://user:password@example.invalid'}]}])await assert.rejects(save(cwd,value),code('invalid'));
 assert.equal(await readFile(target,'utf8'),prior);await writeFile(target,'{secret-password');
 await assert.rejects(load(cwd),error=>error.code==='code-report/configuration-invalid'&&!error.message.includes('secret-password'));
 await writeFile(target,JSON.stringify({...config(),rows:'bad'}));await assert.rejects(load(cwd),code('invalid'));
});
test('nonregular target and hardlinks are rejected without modifying outside data',async t=>{
 const cwd=await workspace(t),outside=await workspace(t),target=path.join(cwd,filename),other=path.join(outside,'config');await writeFile(other,JSON.stringify(config()));
 await link(other,target);await assert.rejects(load(cwd),code('unsafe-path'));await assert.rejects(save(cwd,config()),code('unsafe-path'));
 assert.equal(await readFile(other,'utf8'),JSON.stringify(config()));await rm(target);await mkdir(target);
 await assert.rejects(load(cwd),code('unsafe-path'));await assert.rejects(save(cwd,config()),code('unsafe-path'));
});
test('configuration symlinks cannot escape the workspace, including dangling links',async t=>{
 const cwd=await workspace(t),outside=await workspace(t),target=path.join(cwd,filename),other=path.join(outside,'config');await writeFile(other,JSON.stringify(config()));
 try{await symlink(other,target,'file');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('file symlink creation unavailable: '+error.code);return;}throw error;}
 await assert.rejects(load(cwd),code('unsafe-path'));await assert.rejects(save(cwd,config()),code('unsafe-path'));assert.equal(await readFile(other,'utf8'),JSON.stringify(config()));
 await rm(target);await symlink(path.join(outside,'missing'),target,'file');await assert.rejects(load(cwd),code('unsafe-path'));await assert.rejects(save(cwd,config()),code('unsafe-path'));
});
test('precommit session recheck and cancellation preserve old config and remove temporary files',async t=>{
 const cwd=await workspace(t);await save(cwd,config());const prior=await readFile(path.join(cwd,filename),'utf8');
 const changed=Object.assign(new Error('会话目录已变更'),{code:'code-report/session-changed'});
 await assert.rejects(save(cwd,{...config(),title:'new'},{assertCurrent:async()=>{throw changed;}}),{code:changed.code});
 const controller=new AbortController();controller.abort();await assert.rejects(save(cwd,config(),{signal:controller.signal}),code('cancelled'));
 assert.equal(await readFile(path.join(cwd,filename),'utf8'),prior);assert.deepEqual(await readdir(cwd),[filename]);
 await assert.rejects(load(cwd,{assertCurrent:async()=>{throw changed;}}),{code:changed.code});
});
test('host registered RPC uses session cwd exclusively, isolates roots and resolves persisted sessions',async t=>{
 const one=await workspace(t),two=await workspace(t);let handler;const ctx={sessions:new Map([['one',{header:{cwd:one}}]]),sessionPersistence:{stat:async id=>id==='two'?{header:{cwd:two}}:null},connection:{register(owner,channel,value){assert.equal(owner,ctx);assert.equal(channel,RPC_CHANNEL);handler=value;}}};
 apply(ctx);assert.equal(typeof handler,'function');
 const saved=await handler('configuration-save',{sessionId:'one',cwd:two,path:path.join(two,'attacker.json'),configuration:config()});assert.equal(saved.ok,true,JSON.stringify(saved));
 assert.deepEqual(await handler('configuration-load',{sessionId:'one',cwd:two}),{ok:true,value:cleanConfiguration(config())});
 assert.deepEqual(await handler('configuration-load',{sessionId:'two',cwd:one}),{ok:true,value:null});assert.deepEqual(await readdir(two),[]);
 assert.equal((await handler('configuration-save',{sessionId:'missing',cwd:one,configuration:config()})).error.code,'code-report/session-unavailable');
 assert.equal((await handler('configuration-load',{sessionId:'../one'})).error.code,'code-report/input');
 ctx.sessions.get('one').header.cwd=two;assert.deepEqual(await handler('configuration-load',{sessionId:'one'}),{ok:true,value:null});
 await handler('configuration-save',{sessionId:'two',configuration:{...config(),title:'two'}});assert.equal((await load(one)).title,'发布报告');assert.equal((await load(two)).title,'two');
});
test('host rejects a session cwd changing before commit and never accepts payload cwd fallback',async t=>{
 const one=await workspace(t),two=await workspace(t);let reads=0;const ctx={sessions:{get(){reads++;return {header:{cwd:reads===1?one:two}};}}};
 let handler;apply({...ctx,connection:{register(owner,channel,value){handler=value;}}});
 const result=await handler('configuration-save',{sessionId:'s',configuration:config()});assert.equal(result.ok,false);assert.equal(result.error.code,'code-report/session-changed');assert.deepEqual(await readdir(one),[]);assert.deepEqual(await readdir(two),[]);
 const absent=await handler('configuration-load',{cwd:one});assert.equal(absent.error.code,'code-report/input');
});
test('concurrent saves publish whole configurations without temporary residue',async t=>{
 const cwd=await workspace(t);await Promise.all(Array.from({length:12},(_,i)=>save(cwd,{...config(),title:'version-'+i})));assert.match((await load(cwd)).title,/^version-\d+$/);assert.deepEqual(await readdir(cwd),[filename]);
});
