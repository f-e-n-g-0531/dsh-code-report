import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {run,runGitRead} from '../src/process.mjs';
import {collect} from '../src/collect.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const gbkOld=Buffer.from([0xd6,0xd0,0xce,0xc4,0x20,0xbe,0xc9,10]); // 中文 旧
const gbkNew=Buffer.from([0xd6,0xd0,0xce,0xc4,0x20,0xd0,0xc2,10]); // 中文 新
async function workspace(t){const cwd=await mkdtemp(path.join(tmpdir(),'report-gbk-'));t.after(()=>rm(cwd,{recursive:true,force:true}));return cwd;}

test('raw process output returns exact Buffer while default metadata remains strict UTF-8',async()=>{
 const args=['-e','process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))'];
 const raw=await run(process.execPath,args,{raw:true});
 assert.ok(Buffer.isBuffer(raw));assert.deepEqual(raw,gbkOld.subarray(0,4));
 await assert.rejects(run(process.execPath,args),/元数据.*UTF-8/);
 await assert.rejects(run(process.execPath,args,{raw:'true'}),/元数据.*UTF-8/);
});

test('real Git GBK body with UTF-8 Chinese paths preserves raw hashes and pinned A/B encodings',async t=>{
 const cwd=await workspace(t),root=path.join(cwd,'repo');await mkdir(root);
 const git=args=>run('git',args,{cwd:root});
 await git(['init']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
 const name='中文-api.txt';
 await writeFile(path.join(root,name),Buffer.from('中文 旧\n'));
 await writeFile(path.join(root,'english.txt'),'old\n');
 await git(['add','.']);await git(['commit','-m','base']);const a=(await git(['rev-parse','HEAD'])).trim();
 await writeFile(path.join(root,name),gbkNew);await writeFile(path.join(root,'english.txt'),gbkNew);
 await git(['commit','-am','target']);const b=(await git(['rev-parse','HEAD'])).trim();
 await writeFile(path.join(root,name),'DIRTY');await mkdir(path.join(cwd,'workspace'));await writeFile(path.join(cwd,'workspace','中文.txt'),gbkOld);
 const snapshot=await collect(cwd,{repositories:[{path:'repo',type:'git',a,b}],contextPaths:['workspace'],versionContexts:['A','B'].map(side=>({repository:'repo',side,path:name}))});
 const repo=snapshot.repositories[0];
 assert.ok(repo.files.includes(name));assert.match(repo.diff,/中文 新/);assert.match(repo.diff,/中文 旧/);assert.doesNotMatch(repo.diff,/DIRTY|�/);
 assert.equal(repo.diffEncoding,'utf-8+gb18030');assert.equal(repo.diffHash,digest(repo.diff));assert.notEqual(repo.rawDiffHash,repo.diffHash);
 const raw=await runGitRead(['-c','core.quotePath=false','diff','--no-ext-diff','--no-textconv','--no-renames','--submodule=short','--unified=3',a,b,'--'],{cwd:root,raw:true});
 assert.equal(repo.rawDiffHash,digest(raw));
 assert.deepEqual(snapshot.context.map(c=>c.encoding),['gb18030','utf-8','gb18030']);
 assert.deepEqual(snapshot.context.map(c=>c.text),['中文 旧\n','中文 旧\n','中文 新\n']);
 assert.equal(snapshot.context[0].hash,digest(gbkOld));assert.equal(snapshot.context[2].hash,digest(gbkNew));
 for(const source of snapshot.context)assert.equal(source.hash,source.rawHash);
 assert.equal(await readFile(path.join(root,name),'utf8'),'DIRTY');
});

test('real SVN GBK text and property bodies preserve exact per-entry raw hash and decoded offsets',async t=>{
 const cwd=await workspace(t),root=path.join(cwd,'wc');await run('svnadmin',['create',path.join(cwd,'store')],{cwd});
 const url=pathToFileURL(path.join(cwd,'store')).href;await run('svn',['checkout',url,root,'--non-interactive'],{cwd});
 const svn=(args,options={})=>run('svn',args,{cwd:root,...options});
 const name='中文-api.txt';await writeFile(path.join(root,name),gbkOld);await writeFile(path.join(root,'english.txt'),'UTF8 中文\n');
 await svn(['add','--quiet',name,'english.txt']);await svn(['mkdir','--quiet','internal']);
 // Tracked internal path forces safe per-entry reads instead of a recursive diff.
 await mkdir(path.join(root,'internal','.git'));await writeFile(path.join(root,'internal','.git','opaque'),Buffer.from([0xff]));
 await svn(['add','--quiet','--no-ignore','internal/.git']);await svn(['commit','--quiet','-m','base','--non-interactive']);
 await writeFile(path.join(root,name),gbkNew);await writeFile(path.join(root,'english.txt'),'UTF8 新中文\n');await svn(['delete','--quiet','internal/.git']);
 const prop=path.join(cwd,'property.bin');await writeFile(prop,gbkNew);await svn(['propset','--quiet','test:gbk','--file',prop,name]);
 await svn(['commit','--quiet','-m','target','--non-interactive']);
 const snapshot=await collect(cwd,{allowSvnNetwork:true,repositories:[{path:'wc',type:'svn',branchA:'.',branchB:'.',a:'1',b:'2'}],versionContexts:['A','B'].map(side=>({repository:'wc',path:name,side}))});
 const repo=snapshot.repositories[0];assert.ok(repo.files.includes(name));assert.match(repo.diff,/中文 新/);assert.match(repo.diff,/test:gbk/);assert.doesNotMatch(repo.diff,/�/);
 assert.equal(repo.diffEncoding,'utf-8+gb18030');assert.equal(repo.diffHash,digest(repo.diff));
 const parts=[];let end=0;
 for(const part of repo.diffParts){assert.equal(part.start,end);assert.ok(part.end>part.start);end=part.end;assert.ok(repo.diff.slice(part.start,part.end).startsWith('Index: '));}
 assert.equal(end,repo.diff.length);
 for(const change of repo.changes){const suffix=change.path?'/'+change.path.split('/').map(encodeURIComponent).join('/'):'';parts.push(await svn(['diff','--internal-diff','--depth','empty','--old='+url+suffix+'@1','--new='+url+suffix+'@2','--non-interactive','--no-auth-cache'],{raw:true}));}
 assert.equal(repo.rawDiffHash,digest(Buffer.concat(parts)));
 assert.deepEqual(snapshot.context.map(c=>c.text),['中文 旧\n','中文 新\n']);assert.deepEqual(snapshot.context.map(c=>c.hash),[digest(gbkOld),digest(gbkNew)]);
 // A normal whole-repository diff must decode too, not just the exclusion-safe per-entry path.
 await writeFile(path.join(root,name),gbkOld);await svn(['commit','--quiet','-m','normal raw diff','--non-interactive']);
 const normal=(await collect(cwd,{allowSvnNetwork:true,repositories:[{path:'wc',type:'svn',branchA:'.',branchB:'.',a:'2',b:'3'}]})).repositories[0];
 const normalRaw=await svn(['diff','--internal-diff','--old='+url+'@2','--new='+url+'@3','--non-interactive','--no-auth-cache'],{raw:true});
 assert.equal(normal.diffParts,undefined);assert.deepEqual(normal.excludedPaths,[]);
 assert.match(normal.diff,/中文 旧/);assert.doesNotMatch(normal.diff,/�/);
 // SVN's plain-text path labels follow its platform locale; XML metadata remains UTF-8.
 assert.ok(['gb18030','utf-8+gb18030'].includes(normal.diffEncoding));assert.ok(normal.diff.includes(name));
 assert.equal(normal.rawDiffHash,digest(normalRaw));assert.equal(normal.diffHash,digest(normal.diff));
});

test('source fallback rejects malformed GB18030 and NUL instead of emitting replacement text',async t=>{
 const cwd=await workspace(t),root=path.join(cwd,'repo');await mkdir(root);const git=args=>run('git',args,{cwd:root});
 await git(['init']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);await writeFile(path.join(root,'a.txt'),'safe');await git(['add','.']);await git(['commit','-m','base']);
 const request={repositories:[{path:'repo',type:'git',a:'HEAD',b:'HEAD'}],contextPaths:['bad.txt']};
 for(const bytes of [Buffer.from([0x81]),Buffer.from([0x81,0x30,0x81]),Buffer.from([0,0x61])]){await writeFile(path.join(cwd,'bad.txt'),bytes);await assert.rejects(collect(cwd,request),/GB18030|二进制/);}
});
