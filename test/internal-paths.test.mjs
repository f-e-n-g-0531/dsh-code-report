import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {run} from '../src/process.mjs';
import {collect} from '../src/collect.mjs';
import {internalPath} from '../src/paths.mjs';
import {markdown} from '../src/report.mjs';
test('internal matching is segment based and case insensitive',()=>{for(const p of ['.git','.svn/x','a/.GIT/config','a/.SvN'])assert.ok(internalPath(p));for(const p of ['.gitignore','a/git/x','file.key'])assert.ok(!internalPath(p));});
test('SVN excludes deleted internal bodies but retains nested business changes and directory properties',async t=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'report-exclude-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const exec=(args,root=cwd)=>run('svn',args,{cwd:root});
 await run('svnadmin',['create',path.join(cwd,'store')],{cwd});const url=pathToFileURL(path.join(cwd,'store')).href;
 await exec(['checkout',url,path.join(cwd,'wc'),'--non-interactive']);const wc=path.join(cwd,'wc');
 await mkdir(path.join(wc,'parent','.git'),{recursive:true});await mkdir(path.join(wc,'parent','nested'));await mkdir(path.join(wc,'removed'));await writeFile(path.join(wc,'removed','old.txt'),'deleted business\n');
 // Invalid UTF-8 makes any accidental excluded body read fail, not merely disappear from output.
 await writeFile(path.join(wc,'parent','.git','hidden'),Buffer.from([0xff,0xfe,10]));await writeFile(path.join(wc,'parent','nested','api.txt'),'old\n');
 await exec(['add','parent','removed'],wc);await exec(['commit','-m','base','--non-interactive'],wc);
 await exec(['delete','parent/.git','removed'],wc);await writeFile(path.join(wc,'parent','nested','api.txt'),'new\n');await exec(['propset','test:flag','yes','parent'],wc);await exec(['commit','-m','change','--non-interactive'],wc);
 const request={allowSvnNetwork:true,repositories:[{path:'wc',type:'svn',branchA:'.',branchB:'.',a:'1',b:'2'}]};
 const result=await collect(cwd,request);const repo=result.repositories[0];assert.ok(repo.excludedPaths.includes('parent/.git/hidden'));assert.match(repo.diff,/new/);assert.match(repo.diff,/-deleted business/);assert.match(repo.diff,/test:flag/);assert.doesNotMatch(repo.diff,/hidden|[.]git/);assert.match(markdown(result),/排除的内部路径/);assert.ok(!repo.files.some(internalPath));
 await writeFile(path.join(wc,'.env'),'SECRET');await exec(['add','.env'],wc);await exec(['commit','-m','secret','--non-interactive'],wc);
 await assert.rejects(collect(cwd,{...request,repositories:[{...request.repositories[0],b:'3'}]}),/敏感路径.*[.]env/);
});
test('Git excludes tracked SVN internals before decoding body and preserves business diff',async t=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'report-git-exclude-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const git=args=>run('git',args,{cwd});
 await git(['init']);await git(['config','user.name','Test']);await git(['config','user.email','test@example.com']);await mkdir(path.join(cwd,'.svn'));await writeFile(path.join(cwd,'.svn','hidden'),Buffer.from([0xff,0xfe,10]));await writeFile(path.join(cwd,'api.txt'),'old\n');await git(['add','.']);await git(['commit','-m','base']);const a=(await git(['rev-parse','HEAD'])).trim();
 await rm(path.join(cwd,'.svn'),{recursive:true});await writeFile(path.join(cwd,'api.txt'),'new\n');await git(['add','-A']);await git(['commit','-m','change']);
 const repo=(await collect(cwd,{repositories:[{path:'.',type:'git',a,b:'HEAD'}]})).repositories[0];assert.deepEqual(repo.excludedPaths,['.svn/hidden']);assert.deepEqual(repo.files,['api.txt']);assert.match(repo.diff,/new/);assert.doesNotMatch(repo.diff,/hidden/);
});
