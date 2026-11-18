import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {collect,hash} from '../src/collect.mjs';
import {run} from '../src/process.mjs';
import {decodeDiffBytes} from '../src/text-encoding.mjs';
import {buildSingleRequestEvidence} from '../src/single-request.mjs';

async function svnFixture(t) {
 const cwd=await mkdtemp(path.join(tmpdir(),'report-ordered-svn-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const db=path.join(cwd,'repo'), wc=path.join(cwd,'wc'), url=pathToFileURL(db).href;
 await run('svnadmin',['create',db],{cwd});
 await run('svn',['checkout',url,wc,'--non-interactive'],{cwd});
 const svn=(args, raw=false)=>run('svn',args,{cwd:wc,raw});
 const files=['01.txt','02.txt','03.txt','04.txt','05.txt','06 @%.txt','07.txt'];
 await mkdir(path.join(wc,'parent','.git'),{recursive:true});
 await writeFile(path.join(wc,'parent','.git','hidden'),Buffer.from([0xff,0xfe,10]));
 for(const file of files)await writeFile(path.join(wc,'parent',file),'old\n');
 await svn(['add','parent']);
 await svn(['commit','-m','base','--non-interactive']);
 await svn(['delete','parent/.git']);
 await mkdir(path.join(wc,'parent','empty'));
 await svn(['add','parent/empty']);
 await svn(['propset','test:flag','yes','parent']);
 for(const file of files)await writeFile(path.join(wc,'parent',file),file==='02.txt'?Buffer.from([0xd6,0xd0,10]):'new 中文🤖 '+file+'\n');
 await svn(['commit','-m','changed','--non-interactive']);
 const request={allowSvnNetwork:true,repositories:[{path:'wc',type:'svn',branchA:'.',branchB:'.',a:'1',b:'2'}]};
 return {cwd, url, svn, request};
}

test('ordered SVN windows retain raw bytes, decoded ranges, metadata-only entries and progress',async t=>{
 const {cwd,url,svn,request}=await svnFixture(t);
 const progress=[];
 const {repositories:[repo]}=await collect(cwd,request,undefined,({label})=>{
  if(label.startsWith('读取 SVN 路径：'))progress.push(label);
 });
 assert.ok(repo.files.length>4);
 assert.deepEqual(repo.files,repo.changes.map(change=>change.path));
 assert.deepEqual(repo.excludedPaths.toSorted(),['parent/.git','parent/.git/hidden']);
 assert.deepEqual(progress,repo.files.map((file,i)=>'读取 SVN 路径：wc/'+file+'（'+(i+1)+'/'+repo.files.length+'）'));
 const raw=[], parts=[], texts=[];
 let offset=0;
 for(const file of repo.files){
  const target=url+'/'+file.split('/').map(encodeURIComponent).join('/');
  const bytes=await svn(['diff','--internal-diff','--depth','empty','--old='+target+'@1','--new='+target+'@2','--non-interactive','--no-auth-cache'],true);
  raw.push(bytes);
  const {text}=decodeDiffBytes(bytes);
  if(!text)continue;
  texts.push(text);
  parts.push({path:file,start:offset,end:offset+text.length});
  offset+=text.length;
 }
 assert.deepEqual(repo.diffParts,parts);
 // Snapshot serialization preserves property order.
 assert.deepEqual(Object.keys(repo).filter(key=>['diff','diffParts','rawDiffHash','diffEncoding'].includes(key)),['diff','diffParts','rawDiffHash','diffEncoding']);
 assert.equal(repo.diff, texts.join(''));
 assert.equal(repo.rawDiffHash,hash(Buffer.concat(raw)));
 assert.equal(repo.diffHash,hash(repo.diff));
 assert.equal(repo.diffEncoding,'utf-8+gb18030');
 assert.ok(repo.files.includes('parent/empty'));
 assert.ok(!repo.diffParts.some(part=>part.path==='parent/empty'));
 const empty=(await collect(cwd,{...request,repositories:[{...request.repositories[0],b:'1'}]})).repositories[0];
 assert.deepEqual(empty.files,[]);
 assert.equal(empty.diff,'');
});

test('cancelling during SVN item progress rejects with the original reason and reports no later entries',async t=>{
 const {cwd,request}=await svnFixture(t), controller=new AbortController();
 const reason=new Error('fixture stop');
 let entries=0;
 await assert.rejects(collect(cwd,request,controller.signal,({label})=>{
  if(label.startsWith('读取 SVN 路径：')){entries++;controller.abort(reason);}
 }),error=>error===reason);
 assert.equal(entries,1);
});

function digestFixture(){
 const files=Array.from({length:12},(_,i)=>'src/'+i+'.js').concat('generated.map');
 const line='"\\\t\r\u0000\u001f中文🤖\uD800';
 return {title:'摘要"',limitations:['boundary\\'],context:[{path:'context.txt',text:line.repeat(50)}],repositories:[
  {type:'git',path:'one',files,a:'a',b:'b',diff:files.map(file=>'diff --git a/'+file+' b/'+file+'\n--- a/'+file+'\n+++ b/'+file+'\n@@ -1 +1 @@\n-old\n+'+line.repeat(70)+'\n').join('')},
  {type:'svn',path:'two',files:['api.h'],a:'1',b:'2',diff:'Index: api.h\n@@ -1 +1 @@\n-old\n+'+line.repeat(90)+'\n'},
 ]};
}

test('incremental digest matches complete double-JSON measurement with escaped data and item caps',()=>{
 const source=digestFixture();
 const serialize=items=>Buffer.byteLength(JSON.stringify({content:JSON.stringify({title:source.title,limitations:source.limitations,items})}));
 for(const [inputBudget,maxItems] of [[4000,8],[8209,10],[13579,Infinity],[50000,5]]){
  let fullCalls=0,appendCalls=0;
  const estimate=items=>{fullCalls++;return items.length>maxItems?Number.MAX_SAFE_INTEGER:serialize(items);};
  const baseline=buildSingleRequestEvidence(source,{inputBudget,estimate});
  assert.ok(fullCalls>2);
  fullCalls=0;
  const incremental=buildSingleRequestEvidence(source,{inputBudget,estimate,estimateAppend:(item,size,count)=>{
   appendCalls++;
   return count>=maxItems?Number.MAX_SAFE_INTEGER:size+Buffer.byteLength(JSON.stringify(JSON.stringify(item)))-2+(count?1:0);
  }});
  assert.equal(fullCalls,2);
  assert.ok(appendCalls>0);
  assert.deepEqual(incremental,baseline);
  assert.ok(incremental.items.length<=maxItems);
  assert.equal(incremental.inputBytes,serialize(incremental.items));
 }
});

test('incremental digest still fails closed if final whole-request estimate exceeds budget',()=>{
 const source=digestFixture();
 assert.throws(()=>buildSingleRequestEvidence(source,{inputBudget:4000,
  estimate:items=>items.length>3?4001:100,
  estimateAppend:()=>100,
 }),/最终摘要统计超出预算/);
});
