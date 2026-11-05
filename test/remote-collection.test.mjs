import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {run,runGitRead} from '../src/process.mjs';
import {collect,listRefs} from '../src/collect.mjs';
import {createHandler} from '../src/host.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const gbk=Buffer.from([0xd6,0xd0,0xce,0xc4,0x20,0xd0,0xc2,10]);
async function state(root){
 const entries=[];
 async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await walk(file);else if(item.isFile())entries.push([path.relative(root,file),hash(await readFile(file)),(await stat(file)).mtimeMs]);}}
 await walk(root);return entries.sort((a,b)=>a[0].localeCompare(b[0]));
}
async function fixture(t){
 const cwd=await mkdtemp(path.join(tmpdir(),'report-remote-collection-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const seed=path.join(cwd,'seed'),bare=path.join(cwd,'remote.git'),root=path.join(cwd,'local');await mkdir(seed);
 const git=args=>run('git',args,{cwd:seed});
 await git(['init','-b','main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
 await writeFile(path.join(seed,'api.txt'),'LOCAL BASE\n');await git(['add','.']);await git(['commit','-m','base']);
 const base=(await git(['rev-parse','HEAD'])).trim();await run('git',['init','--bare',bare],{cwd});await git(['remote','add','origin',pathToFileURL(bare).href]);await git(['push','origin','main']);
 await run('git',['clone','--single-branch','--branch','main',pathToFileURL(bare).href,root],{cwd});
 await writeFile(path.join(seed,'api.txt'),'REMOTE MAIN\n');await git(['commit','-am','remote main']);const main=(await git(['rev-parse','HEAD'])).trim();await git(['push','origin','main']);
 await git(['checkout','-b','develop']);await writeFile(path.join(seed,'api.txt'),'REMOTE DEVELOP\n');await writeFile(path.join(seed,'中文.txt'),gbk);await git(['add','.']);await git(['commit','-m','remote develop']);const develop=(await git(['rev-parse','HEAD'])).trim();await git(['push','origin','develop']);
 await writeFile(path.join(root,'api.txt'),'DIRTY LOCAL NEVER UPLOADED');
 return {cwd,root,seed,bare,git,base,main,develop,row:{path:'local',type:'git',gitMode:'remote',gitRemote:'origin',branchA:'main',branchB:'develop',a:'',b:''}};
}

test('remote collection uses fresh main/develop and isolated version context without mutating source',async t=>{
 const f=await fixture(t),before=await state(f.root);
 await assert.rejects(runGitRead(['cat-file','-e',f.develop],{cwd:f.root}));
 const localRefs=await listRefs(f.cwd,'local',undefined,{gitMode:'local'});assert.ok(!localRefs.some(ref=>ref.endsWith('/develop')));
 const remoteRefs=await listRefs(f.cwd,'local',undefined,{gitMode:'remote',gitRemote:'origin'});assert.ok(remoteRefs.includes('refs/heads/develop'));
 const snapshot=await collect(f.cwd,{repositories:[f.row],versionContexts:[{repository:'local',side:'B',path:'中文.txt'},{repository:'local',side:'A',path:'api.txt'}]});
 const repo=snapshot.repositories[0];assert.equal(repo.branchA,'main');assert.equal(repo.branchB,'develop');assert.equal(repo.a,f.main);assert.equal(repo.b,f.develop);assert.equal(repo.gitSource,'remote');assert.equal(repo.remote,'origin');assert.ok(Number.isFinite(Date.parse(repo.observedAt)));
 assert.match(repo.diff,/REMOTE DEVELOP/);assert.doesNotMatch(repo.diff,/LOCAL BASE|DIRTY LOCAL/);
 assert.equal(snapshot.context[0].text,'中文 新\n');assert.equal(snapshot.context[0].hash,hash(gbk));assert.equal(snapshot.context[0].encoding,'gb18030');assert.equal(snapshot.context[0].provenance,'version-B');assert.equal(snapshot.context[0].revision,f.develop);
 assert.equal(snapshot.context[1].text,'REMOTE MAIN\n');assert.equal(snapshot.context[1].revision,f.main);
 for(const ref of ['origin/develop','refs/remotes/origin/develop','refs/heads/develop']){const s=await collect(f.cwd,{repositories:[{...f.row,branchB:ref}]});assert.equal(s.repositories[0].b,f.develop);}
 const pinned=await collect(f.cwd,{repositories:[{...f.row,a:f.main,b:f.develop}]});
 assert.equal(pinned.repositories[0].branchA,'main');assert.equal(pinned.repositories[0].branchB,'develop');
 assert.equal(pinned.repositories[0].a,f.main);assert.equal(pinned.repositories[0].b,f.develop);
 const local=await collect(f.cwd,{repositories:[{...f.row,gitMode:'local',branchB:'main'}]});assert.equal(local.repositories[0].a,f.base);assert.equal(local.repositories[0].b,f.base);
 const legacy={...f.row,branchB:'main'};delete legacy.gitMode;assert.equal((await collect(f.cwd,{repositories:[legacy]})).repositories[0].a,f.base);
 await assert.rejects(collect(f.cwd,{repositories:[{...f.row,gitMode:'local'}]}),error=>/local/.test(error.message)&&/B/.test(error.message)&&/develop/.test(error.message));
 assert.deepEqual(await state(f.root),before);
});

test('remote failures never fall back locally and malformed modes are rejected',async t=>{
 const f=await fixture(t);let authRequests=0;
 const server=createServer((request,response)=>{authRequests++;response.writeHead(401,{'WWW-Authenticate':'Basic realm=fixture'});response.end('Denied');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const authAddress='http://fixture-user:fixture-secret@127.0.0.1:'+server.address().port+'/private.git';
 await run('git',['remote','add','auth-denied',authAddress],{cwd:f.root});
 const before=await state(f.root);
 for(const gitMode of [null,'invalid',true])await assert.rejects(collect(f.cwd,{repositories:[{...f.row,gitMode}]}),/来源模式/);
 await assert.rejects(listRefs(f.cwd,'local',undefined,{gitMode:null}),/来源模式/);
 for(const gitRemote of ['missing','https://credential.invalid/repo','../remote.git']){
  await assert.rejects(collect(f.cwd,{repositories:[{...f.row,gitRemote,branchB:'main'}]}),error=>/远端/.test(error.message)&&!error.message.includes('credential.invalid'));
 }
 await assert.rejects(collect(f.cwd,{repositories:[{...f.row,branchB:'absent'}]}),error=>/absent/.test(error.message));
 await assert.rejects(collect(f.cwd,{repositories:[{...f.row,gitRemote:'auth-denied',branchB:'main'}]}),error=>/未回退/.test(error.message)&&!/fixture-secret|fixture-user|127\.0\.0\.1/.test(error.message));
 assert.ok(authRequests>0,'fixture must exercise an actual HTTP authentication rejection');
 assert.deepEqual(await state(f.root),before);
});

test('host preview freezes remote evidence and sends it only after explicit consent',async t=>{
 const f=await fixture(t),before=await state(f.root),calls=[];
 const llm={async *stream(input){calls.push(input);const batch=JSON.parse(input.messages[0].content[0].text);const first=batch.evidence[0].id;yield {type:'text-delta',text:JSON.stringify({changes:[{text:'冻结差异',evidenceIds:[first]}],interfaces:[],impacts:[],qa:[],unknowns:[]})};yield {type:'finish',reason:{kind:'stop'}};}};
 const rpc=createHandler({sessions:{get:()=>({header:{cwd:f.cwd}})},sessionPersistence:{},llm});
 const request={repositories:[f.row],versionContexts:[{repository:'local',side:'B',path:'中文.txt'}]};
 const response=await rpc('preview',{sessionId:'s',request});assert.equal(response.ok,true,JSON.stringify(response));const p=response.value;
 assert.equal(calls.length,0);assert.equal(p.repositories[0].gitSource,'remote');assert.equal(p.repositories[0].identity.remote,'origin');assert.ok(Number.isFinite(Date.parse(p.repositories[0].observedAt)));
 assert.equal(p.repositories[0].diff,undefined);assert.equal(p.context[0].text,undefined);assert.ok(!JSON.stringify(p.repositories).includes(pathToFileURL(f.bare).href));
 const payload={sessionId:'s',previewId:p.previewId,planId:p.analysisPlan.id,route:{provider:'fixture',model:'fixture'}};
 const denied=await rpc('generate',{...payload,operationId:'remote-denied'});assert.equal(denied.ok,false);assert.match(denied.error.message,/确认|授权/);assert.equal(calls.length,0);
 await writeFile(path.join(f.seed,'api.txt'),'LATER REMOTE NOT IN PREVIEW\n');await writeFile(path.join(f.seed,'中文.txt'),'LATER CONTEXT NOT IN PREVIEW');await f.git(['commit','-am','later remote']);await f.git(['push','origin','develop']);
 const result=await rpc('generate',{...payload,operationId:'remote-confirmed',sendToModel:true});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(calls.length>0);
 const sent=calls.map(input=>input.messages[0].content[0].text).join('\n');assert.ok(sent.includes('REMOTE DEVELOP'));assert.ok(sent.includes('中文 新'));assert.ok(!sent.includes('LATER REMOTE'));assert.ok(!sent.includes('LATER CONTEXT'));assert.ok(!sent.includes('DIRTY LOCAL'));
 assert.deepEqual(await state(f.root),before);
});
