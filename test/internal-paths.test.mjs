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
 const result=await collect(cwd,request);const repo=result.repositories[0];assert.ok(repo.excludedPaths.includes('parent/.git/hidden'));assert.match(repo.diff,/new/);assert.match(repo.diff,/-deleted business/);assert.match(repo.diff,/test:flag/);assert.doesNotMatch(repo.diff,/hidden|[.]git/);assert.match(markdown(result),/排除的内部路径/);assert.ok(!repo.files.some(internalPath));assert.ok(!repo.changes.some(change=>internalPath(change.path)));assert.deepEqual(repo.changes.find(change=>change.path==='parent'),{path:'parent',kind:'dir',item:'none',props:'modified'});assert.deepEqual(repo.changes.find(change=>change.path==='parent/nested/api.txt'),{path:'parent/nested/api.txt',kind:'file',item:'modified',props:'none'});
 let offset=0;
 for(const part of repo.diffParts){
  assert.equal(part.start,offset);
  assert.ok(part.end>part.start);
  assert.ok(repo.files.includes(part.path));
  assert.ok(repo.diff.slice(part.start,part.end).startsWith('Index: '));
  offset=part.end;
 }
 assert.equal(offset,repo.diff.length);
 const parentPart=repo.diffParts.find(part=>part.path==='parent');
 assert.match(repo.diff.slice(parentPart.start,parentPart.end),/Property changes on: \./);
 await writeFile(path.join(wc,'.env'),'SECRET');await exec(['add','.env'],wc);await exec(['commit','-m','secret','--non-interactive'],wc);
 await assert.rejects(collect(cwd,{...request,repositories:[{...request.repositories[0],b:'3'}]}),/敏感路径.*[.]env/);
});
test('Git excludes tracked SVN internals before decoding body and preserves business diff',async t=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'report-git-exclude-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const git=args=>run('git',args,{cwd});
 await git(['init']);await git(['config','user.name','Test']);await git(['config','user.email','test@example.com']);await mkdir(path.join(cwd,'.svn'));await writeFile(path.join(cwd,'.svn','hidden'),Buffer.from([0xff,0xfe,10]));await writeFile(path.join(cwd,'api.txt'),'old\n');await git(['add','.']);await git(['commit','-m','base']);const a=(await git(['rev-parse','HEAD'])).trim();
 await rm(path.join(cwd,'.svn'),{recursive:true});await writeFile(path.join(cwd,'api.txt'),'new\n');await git(['add','-A']);await git(['commit','-m','change']);
 const repo=(await collect(cwd,{repositories:[{path:'.',type:'git',a,b:'HEAD'}]})).repositories[0];assert.deepEqual(repo.excludedPaths,['.svn/hidden']);assert.deepEqual(repo.files,['api.txt']);assert.match(repo.diff,/new/);assert.doesNotMatch(repo.diff,/hidden/);
});

test('SVN summarize preserves directory, root, and property-only changes without altering files', async t => {
 const cwd = await mkdtemp(path.join(tmpdir(), 'report-svn-properties-'));
 t.after(() => rm(cwd, {recursive:true, force:true}));
 await run('svnadmin', ['create', path.join(cwd,'store')], {cwd});
 const url = pathToFileURL(path.join(cwd,'store')).href;
 const root = path.join(cwd,'wc');
 await run('svn', ['checkout', url, root, '--non-interactive'], {cwd});
 const svn = args => run('svn', args, {cwd:root});
 await mkdir(path.join(root,'directory'));
 await writeFile(path.join(root,'directory','api.txt'), 'unchanged content\n');
 await svn(['add','directory']);
 await svn(['commit','-m','baseline','--non-interactive']);
 // Update before root property commit: otherwise the root directory can be out of date.
 await svn(['update','--non-interactive']);
 for (const target of ['.','directory','directory/api.txt']) await svn(['propset','test:flag','yes',target]);
 await mkdir(path.join(root,'empty-added'));
 await svn(['add','empty-added']);
 await svn(['commit','-m','properties and directory','--non-interactive']);
 const request = {allowSvnNetwork:true,repositories:[{path:'wc',type:'svn',branchA:'.',branchB:'.',a:'1',b:'2'}]};
 const repo = (await collect(cwd,request)).repositories[0];
 assert.equal(repo.diffParts, undefined);
 assert.deepEqual(repo.changes.map(change=>change.path), repo.files);
 for (const name of ['', 'directory','directory/api.txt']) {
  assert.deepEqual(repo.changes.find(change=>change.path===name), {path:name,kind:name.endsWith('.txt')?'file':'dir',item:'none',props:'modified'});
 }
 assert.deepEqual(repo.changes.find(change=>change.path==='empty-added'), {path:'empty-added',kind:'dir',item:'added',props:'none'});
 assert.match(repo.diff, /Property changes on: directory\/api.txt/);
 assert.match(repo.diff, /Property changes on: \./);
 assert.ok(repo.diff.includes('test:flag'));
});
