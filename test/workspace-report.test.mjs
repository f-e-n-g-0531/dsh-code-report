import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,realpath,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {saveWorkspaceReport as save} from '../src/workspace-report.mjs';
import {reportDownloadText} from '../src/report-export.mjs';

const dirname='dsh-code-report-reports';
const markdown='# ../../outside.md\n\n## 本次比较范围\n\n公开范围\n\n## 改动内容\n\n修改 src/private.mjs [1](#evidence-1)\n\n<details>\nsecret-evidence\n</details>\n';
const safeError={code:'code-report/report-save',message:'报告保存失败，请检查当前会话工作目录后重试'};
async function workspace(t){const cwd=await realpath(await mkdtemp(path.join(tmpdir(),'workspace-report-')));t.after(()=>rm(cwd,{recursive:true,force:true}));return cwd;}
async function directoryLink(t,target,destination){try{await symlink(target,destination,process.platform==='win32'?'junction':'dir');return true;}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('directory links unavailable: '+error.code);return false;}throw error;}}

test('saved bytes equal the formal analysis export and titles cannot choose a path',async t=>{
 const cwd=await workspace(t),result=await save(cwd,markdown);
 assert.equal(result.status,'saved');assert.equal(path.isAbsolute(result.path),true);
 assert.equal(path.dirname(result.path),path.join(cwd,dirname));
 assert.match(path.basename(result.path),/^release-report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}\.md$/);
 const content=await readFile(result.path,'utf8');assert.equal(content,reportDownloadText(markdown,'analysis'));assert.doesNotMatch(content,/secret-evidence|private\.mjs/);
 const stat=await lstat(result.path);assert.equal(stat.isFile(),true);assert.equal(stat.nlink,1);
 if(process.platform!=='win32')assert.equal(stat.mode&0o777,0o600);
 assert.deepEqual(await readdir(cwd),[dirname]);assert.deepEqual(await readdir(path.dirname(result.path)),[path.basename(result.path)]);
});
test('concurrent saves have unique names, preserve existing bytes and leave no partial files',async t=>{
 const cwd=await workspace(t),folder=path.join(cwd,dirname);await mkdir(folder);await writeFile(path.join(folder,'existing.md'),'untouched');
 const saved=await Promise.all(Array.from({length:12},(_,i)=>save(cwd,markdown+'\n## QA 测试范围\nversion-'+i)));
 assert.equal(new Set(saved.map(value=>value.path)).size,12);
 for(let i=0;i<saved.length;i++)assert.equal(await readFile(saved[i].path,'utf8'),reportDownloadText(markdown+'\n## QA 测试范围\nversion-'+i,'analysis'));
 assert.equal(await readFile(path.join(folder,'existing.md'),'utf8'),'untouched');assert.equal((await readdir(folder)).length,13);
});
test('workspace links, ancestor links and linked report directories are refused',async t=>{
 const cwd=await workspace(t),outside=await workspace(t),alias=path.join(cwd,'alias');
 if(!await directoryLink(t,outside,alias))return;
 await assert.rejects(save(alias,markdown),safeError);assert.deepEqual(await readdir(outside),[]);
 await mkdir(path.join(outside,'nested'));await assert.rejects(save(path.join(alias,'nested'),markdown),safeError);assert.deepEqual(await readdir(path.join(outside,'nested')),[]);
 await directoryLink(t,outside,path.join(cwd,dirname));await assert.rejects(save(cwd,markdown),safeError);assert.deepEqual(await readdir(outside),['nested']);
});
test('a dangling report directory link is refused without creating its target',async t=>{
 const cwd=await workspace(t),outside=await workspace(t),missing=path.join(outside,'missing');
 if(!await directoryLink(t,missing,path.join(cwd,dirname)))return;
 await assert.rejects(save(cwd,markdown),safeError);assert.deepEqual(await readdir(outside),[]);
});
test('assertCurrent failures before work and before publication are sanitized and clean owned fragments',async t=>{
 const cwd=await workspace(t),secret=new Error('secret-token '+cwd);secret.code='code-report/secret-'+cwd;
 await assert.rejects(save(cwd,markdown,{assertCurrent:async()=>{throw secret;}}),safeError);assert.deepEqual(await readdir(cwd),[]);
 let checks=0;await assert.rejects(save(cwd,markdown,{assertCurrent:async()=>{if(++checks===2)throw secret;}}),safeError);
 assert.equal(checks,2);assert.deepEqual(await readdir(path.join(cwd,dirname)),[]);
});
test('a publication collision never overwrites existing data and cleans only its own temporary file',async t=>{
 const cwd=await workspace(t),folder=path.join(cwd,dirname);let checks=0,target;
 await assert.rejects(save(cwd,markdown,{assertCurrent:async()=>{
  if(++checks!==2)return;
  const [temporary]=await readdir(folder);target=path.join(folder,temporary.slice(1).replace(/\.[0-9a-f-]{36}\.tmp$/,''));
  await writeFile(target,'do not overwrite',{flag:'wx'});
 }}),safeError);
 assert.equal(await readFile(target,'utf8'),'do not overwrite');assert.deepEqual(await readdir(folder),[path.basename(target)]);
});
test('invalid input and filesystem failures disclose neither paths, contents nor underlying errors',async t=>{
 const cwd=await workspace(t);await writeFile(path.join(cwd,dirname),'private-data');
 for(const root of [cwd,path.join(cwd,'secret-missing'),null,'relative','bad\0path']){
  await assert.rejects(save(root,markdown),error=>{
   assert.equal(error.code,safeError.code);assert.equal(error.message,safeError.message);assert.equal(error.cause,undefined);
   assert.doesNotMatch(JSON.stringify(error),/private-data|secret-missing|ENOENT|EEXIST/);return true;
  });
 }
 await assert.rejects(save(await workspace(t),null),safeError);
 assert.equal(await readFile(path.join(cwd,dirname),'utf8'),'private-data');
});
