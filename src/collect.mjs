import path from 'node:path';
import {scanOptions} from './configuration.mjs';
import {realpath,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {inside,regular,secretPath,internalPath} from './paths.mjs';
import {run} from './process.mjs';
import {svnRevision,svnBranch,branchUrl} from './svn-endpoint.mjs';
const MAX_REPOSITORIES=12,MAX_CONTEXT_FILES=20,MAX_CONTEXT_FILE_BYTES=128*1024,MAX_EVIDENCE_BYTES=1024*1024,MAX_DISCOVERED_PROJECTS=500,SCAN_BUDGET_MS=120000,DIRECTORY_PROGRESS_INTERVAL=50;
const SKIP_DIRECTORY=/^(\.|node_modules$|dist$|build$|Library$|Temp$|obj$|bin$)/i;
const GIT_DIFF_FLAGS=['--no-color','--no-ext-diff','--no-textconv','--ignore-submodules=none'];
const GIT_INTERNAL_EXCLUSIONS=[':(exclude,icase,glob)**/.git',':(exclude,icase,glob)**/.git/**',':(exclude,icase,glob)**/.svn',':(exclude,icase,glob)**/.svn/**'];
const SVN_ACCESS_ARGS=['--non-interactive','--no-auth-cache'];
const xml=text=>{if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)throw new Error('无效 SVN XML');return new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false}).parse(text);};
const list=x=>x===undefined?[]:Array.isArray(x)?x:[x];
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function revision(value,type){if(typeof value!=='string'||!value||value.length>256||/[\x00-\x20]/.test(value)||value.startsWith('-')||(type==='svn'&&!/^\d+$/.test(value)))throw new Error(type==='svn'?'SVN 版本必须是固定数字':'无效 Git 版本');return value;}
async function enterDirectory(dir,base,seen,readdir,warnings){
 try{const canonical=await realpath(dir);const rel=path.relative(base,canonical);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||seen.has(canonical))return null;seen.add(canonical);return await readdir(dir,{withFileTypes:true});}catch(e){warnings.push('未能读取目录：'+(path.relative(base,dir)||'.'));return null;}
}
async function describeProject(dir,base,entries,signal,warnings){
 const type=entries.some(x=>x.name==='.git')?'git':entries.some(x=>x.name==='.svn')?'svn':null;
 if(!type)return null;
 const row={path:path.relative(base,dir).split(path.sep).join('/')||'.',type};
 if(type==='svn'){try{const info=xml(await run('svn',['info','--xml','--non-interactive','--',dir+'@'],{cwd:dir,signal})).info.entry;const relative=info?.['relative-url'];if(typeof relative==='string'&&relative.startsWith('^/'))row.branch=decodeURIComponent(relative.slice(2))||'.';}catch(e){signal?.throwIfAborted();warnings.push('无法读取 SVN 分支：'+row.path+'，请手动填写');}}
 return row;
}
const childDirectories=entries=>entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&!SKIP_DIRECTORY.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name));
export async function discover(cwd,signal,options={},onProgress=()=>{}){
 const {maxDepth,maxDirectories}=scanOptions(options);const deadline=Date.now()+SCAN_BUDGET_MS;
 const {readdir}=await import('node:fs/promises');const found=[],warnings=[];let visited=0,limited=false;
 const base=await realpath(cwd),seen=new Set();
 const queue=[{dir:base,depth:0}];
 async function walk(dir,depth){
  signal?.throwIfAborted();if(visited>=maxDirectories){limited=true;return;}visited++;
  const entries=await enterDirectory(dir,base,seen,readdir,warnings);if(!entries)return;
  const row=await describeProject(dir,base,entries,signal,warnings);if(row)found.push(row);
  if(depth>=maxDepth)return;
  for(const child of childDirectories(entries)){if(queue.length>=maxDirectories){limited=true;break;}queue.push({dir:path.join(dir,child.name),depth:depth+1});}
 }
 async function traverseQueue(){
  for(let i=0;i<queue.length;i++){signal?.throwIfAborted();if(visited>=maxDirectories||Date.now()>=deadline||found.length>=MAX_DISCOVERED_PROJECTS){limited=true;break;}await walk(queue[i].dir,queue[i].depth);if(visited%DIRECTORY_PROGRESS_INTERVAL===0)onProgress({phase:'discovering',completed:visited,total:0,label:'已检查 '+visited+' 个目录，发现 '+found.length+' 个项目'});}
 }
 await traverseQueue();
 if(limited)warnings.push('本次根目录及一级文件夹扫描因目录数量、500 项目或 120 秒安全预算未完成；未扫描部分请手动补充。');
 return {repositories:found.sort((a,b)=>a.path.localeCompare(b.path)),warnings,visited,limits:{maxDepth,maxDirectories},limited};
}
function validateRequest(request){if(!request||!Array.isArray(request.repositories)||!request.repositories.length||request.repositories.length>MAX_REPOSITORIES)throw new Error('请选择 1–12 个项目');if(request.contextPaths!==undefined&&(!Array.isArray(request.contextPaths)||request.contextPaths.length>MAX_CONTEXT_FILES))throw new Error('最多附带 20 个源码文件');}
function assertNoSecretPaths(repo){if(repo.files.some(secretPath))throw new Error('项目 '+repo.path+' 差异包含敏感路径：'+repo.files.filter(secretPath).join('、'));}
function assertEvidenceSize(value){if(Buffer.byteLength(value)>MAX_EVIDENCE_BYTES)throw new Error('报告证据超过 1 MiB；请分批比较，未静默截断');}
async function readContextFile(cwd,name){
 const file=await regular(cwd,name);const handle=await open(file,'r');let buf;
 try{const stat=await handle.stat();if(stat.size>MAX_CONTEXT_FILE_BYTES)throw new Error('单个源码文件不能超过 128 KiB');const buffer=Buffer.alloc(MAX_CONTEXT_FILE_BYTES+1);let offset=0;while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}buf=buffer.subarray(0,offset);}finally{await handle.close();}
 if(buf.length>MAX_CONTEXT_FILE_BYTES||buf.includes(0))throw new Error('源码文件过大或为二进制');
 return {path:name,provenance:'current-workspace',hash:hash(buf),text:new TextDecoder('utf-8',{fatal:true}).decode(buf)};
}
async function gitEvidence(exec,root,repo,a,b){
 const top=(await exec('git',['rev-parse','--show-toplevel'])).trim();if(await realpath(top)!==await realpath(root))throw new Error('请指定 Git 仓库根目录');
 const resolve=async ref=>{const id=(await exec('git',['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).trim();if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))throw new Error('无法解析提交');return id;};
 repo.a=await resolve(a);repo.b=await resolve(b);
 repo.files=(await exec('git',['diff',...GIT_DIFF_FLAGS,'--no-renames','--name-only','-z',repo.a,repo.b,'--'])).split('\0').filter(Boolean);
 repo.excludedPaths=repo.files.filter(internalPath);repo.files=repo.files.filter(p=>!internalPath(p));
 assertNoSecretPaths(repo);
 const exclusions=repo.excludedPaths.length?GIT_INTERNAL_EXCLUSIONS:[];
 repo.diff=await exec('git',['-c','core.quotePath=false','diff',...GIT_DIFF_FLAGS,'--no-renames','--submodule=short','--unified=3',repo.a,repo.b,'--',...exclusions]);
 repo.summary=await exec('git',['diff',...GIT_DIFF_FLAGS,'--stat',repo.a,repo.b,'--',...exclusions]);
}
async function svnResolveEndpoint(exec,info,url,rev){
 const endpoint=xml(await exec('svn',['info','--xml','-r',rev,...SVN_ACCESS_ARGS,'--',url+'@'+rev])).info.entry;
 if(endpoint?.repository?.uuid!==info.repository.uuid||endpoint?.repository?.root!==info.repository.root)throw new Error('SVN 分支不属于同一仓库');
 if(rev!=='HEAD')return rev;
 const head=svnRevision(endpoint['@_revision']);
 const entries=list(xml(await exec('svn',['log','--xml','--limit','1','-r',head+':0',...SVN_ACCESS_ARGS,'--',url+'@'+head])).log?.logentry);
 if(entries.length!==1)throw new Error('无法解析 SVN 分支最新提交');
 return svnRevision(entries[0]['@_revision']);
}
function svnChange(x,urlA,urlB){
 const name=typeof x==='string'?x:x['#text'];
 const base=[urlA,urlB].find(url=>name===url||name.startsWith(url+'/'));
 if(!base)throw new Error('SVN 变更路径不属于比较端点');
 const relative=decodeURIComponent(name.slice(base.length).replace(/^\//,''));
 if(relative.split('/').some(p=>p==='..'||p==='.')||relative.includes('\\'))throw new Error('无效 SVN 变更路径');
 return {relative,kind:x['@_kind']};
}
async function svnEntryDiff(exec,repo,entry,urlA,urlB){
 if(!['file','dir'].includes(entry.kind))throw new Error('无法安全判断 SVN 变更类型');
 const suffix=entry.relative?'/'+entry.relative.split('/').map(encodeURIComponent).join('/'):'';
 return exec('svn',['diff','--internal-diff','--depth','empty','--old='+urlA+suffix+'@'+repo.a,'--new='+urlB+suffix+'@'+repo.b,...SVN_ACCESS_ARGS]);
}
async function svnEvidence(exec,repo,root,row,request,a,b){
 if(request.allowSvnNetwork!==true)throw new Error('SVN 历史读取需要勾选仓库访问授权');
 const branchA=svnBranch(row.branchA),branchB=svnBranch(row.branchB);
 const info=xml(await exec('svn',['info','--xml','--non-interactive','--',root+'@'])).info.entry;
 if(!info?.url||!info.repository?.uuid||!info.repository?.root||!info['wc-info'])throw new Error('需要 SVN 工作副本目录');
 repo.a=a;repo.b=b;repo.branchA=branchA;repo.branchB=branchB;
 const urlA=branchUrl(info.repository.root,info.url,branchA),urlB=branchUrl(info.repository.root,info.url,branchB);
 repo.a=await svnResolveEndpoint(exec,info,urlA,a);repo.b=await svnResolveEndpoint(exec,info,urlB,b);
 repo.identity={uuid:info.repository.uuid,repositoryRoot:info.repository.root,urlA,urlB};
 const targets=['--old='+urlA+'@'+repo.a,'--new='+urlB+'@'+repo.b];
 const entries=list(xml(await exec('svn',['diff','--summarize','--xml',...targets,...SVN_ACCESS_ARGS])).diff?.paths?.path).map(x=>svnChange(x,urlA,urlB));
 repo.excludedPaths=entries.filter(x=>internalPath(x.relative)).map(x=>x.relative);
 const included=entries.filter(x=>!internalPath(x.relative));repo.files=included.map(x=>x.relative);
 assertNoSecretPaths(repo);
 if(!repo.excludedPaths.length)repo.diff=await exec('svn',['diff','--internal-diff',...targets,...SVN_ACCESS_ARGS]);
 else{
  // Never request a recursive parent diff after exclusions: deleted directories contain old bodies too.
  repo.diff='';
  for(const entry of included){repo.diff+=await svnEntryDiff(exec,repo,entry,urlA,urlB);assertEvidenceSize(repo.diff);}
 }
 repo.summary=repo.files.join('\n');
}
async function collectRepository(cwd,row,request,signal){
 signal?.throwIfAborted();if(!row||!['git','svn'].includes(row.type))throw new Error('仅支持 Git / SVN');
 const requested=side=>{const value=row[side];if(typeof value!=='string')throw new Error('版本必须是文本，留空表示分支最新提交');return value.trim();};
 const versionA=requested('a'),versionB=requested('b');
 const root=await inside(cwd,row.path,{root:true}),a=row.type==='svn'?(versionA?svnRevision(versionA):'HEAD'):revision(versionA||row.branchA,'git'),b=row.type==='svn'?(versionB?svnRevision(versionB):'HEAD'):revision(versionB||row.branchB,'git');
 const exec=(cmd,args)=>run(cmd,args,{cwd:root,signal});const repo={path:row.path||'.',type:row.type,a,b};
 if(row.type==='git')await gitEvidence(exec,root,repo,a,b);else await svnEvidence(exec,repo,root,row,request,a,b);
 return {repo,requestedA:a,requestedB:b};
}
export async function collect(cwd,request,signal,onProgress=()=>{}){
 validateRequest(request);
 const result={title:typeof request.title==='string'?request.title.slice(0,160):'版本发布报告',createdAt:new Date().toISOString(),repositories:[],context:[],limitations:['差异仅比较两个版本端点，不包含未提交修改；Git 子模块仅记录指针变化，不递归分析。','源码上下文为显式选择的当前工作区文件，不代表版本 A 或 B；未执行测试。','影响分析不是完整调用图；二进制、LFS 内容及未提供源码的行为需要人工验证。']};
 const total=request.repositories.length+(request.contextPaths||[]).length;let completed=0;
 onProgress({phase:'collecting',completed,total,label:'准备读取版本差异'});
 for(const row of request.repositories){
  onProgress({phase:'collecting',completed,total,label:'读取项目：'+row.path});
  const {repo,requestedA,requestedB}=await collectRepository(cwd,row,request,signal);
  if(repo.excludedPaths?.length)result.limitations.push('项目 '+repo.path+' 已在正文读取前排除 '+repo.excludedPaths.length+' 条 .git / .svn 内部路径记录；未读取其正文，不属于本报告分析覆盖。');
  repo.requestedA=requestedA;repo.requestedB=requestedB;repo.diffHash=hash(repo.diff);result.repositories.push(repo);
  onProgress({phase:'collecting',completed:++completed,total,label:'项目差异已采集：'+row.path});
 }
 for(const name of request.contextPaths||[]){onProgress({phase:'collecting',completed,total,label:'读取源码：'+name});result.context.push(await readContextFile(cwd,name));onProgress({phase:'collecting',completed:++completed,total,label:'源码已采集：'+name});}
 assertEvidenceSize(JSON.stringify(result));
 return result;
}
