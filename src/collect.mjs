import path from 'node:path';
import {scanOptions} from './configuration.mjs';
import {realpath,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {inside,regular,secretPath,internalPath} from './paths.mjs';
import {run} from './process.mjs';
import {svnRevision,svnBranch,branchUrl} from './svn-endpoint.mjs';
const xml=text=>{if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)throw new Error('无效 SVN XML');return new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false}).parse(text);};
const list=x=>x===undefined?[]:Array.isArray(x)?x:[x];
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function revision(value,type){if(typeof value!=='string'||!value||value.length>256||/[\x00-\x20]/.test(value)||value.startsWith('-')||(type==='svn'&&!/^\d+$/.test(value)))throw new Error(type==='svn'?'SVN 版本必须是固定数字':'无效 Git 版本');return value;}
export async function discover(cwd,signal,options={},onProgress=()=>{}){
 const {maxDepth,maxDirectories}=scanOptions(options);const deadline=Date.now()+120000;
 const {readdir}=await import('node:fs/promises');const found=[],warnings=[];let visited=0,limited=false;
 const base=await realpath(cwd),seen=new Set();
 const queue=[{dir:base,depth:0}];
 async function walk(dir,depth){
  signal?.throwIfAborted();if(visited>=maxDirectories){limited=true;return;}visited++;
  let canonical,entries;try{canonical=await realpath(dir);const rel=path.relative(base,canonical);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||seen.has(canonical))return;seen.add(canonical);entries=await readdir(dir,{withFileTypes:true});}catch(e){warnings.push('未能读取目录：'+(path.relative(base,dir)||'.'));return;}
  const type=entries.some(x=>x.name==='.git')?'git':entries.some(x=>x.name==='.svn')?'svn':null;
  if(type){const row={path:path.relative(base,dir).split(path.sep).join('/')||'.',type};
   if(type==='svn'){try{const info=xml(await run('svn',['info','--xml','--non-interactive','--',dir+'@'],{cwd:dir,signal})).info.entry;const relative=info?.['relative-url'];if(typeof relative==='string'&&relative.startsWith('^/'))row.branch=decodeURIComponent(relative.slice(2))||'.';}catch(e){signal?.throwIfAborted();warnings.push('无法读取 SVN 分支：'+row.path+'，请手动填写');}}
   found.push(row);
  }
  const children=entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&!/^(\.|node_modules$|dist$|build$|Library$|Temp$|obj$|bin$)/i.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name));
  if(depth>=maxDepth)return;
  for(const child of children){if(queue.length>=maxDirectories){limited=true;break;}queue.push({dir:path.join(dir,child.name),depth:depth+1});}
 }
 for(let i=0;i<queue.length;i++){signal?.throwIfAborted();if(visited>=maxDirectories||Date.now()>=deadline||found.length>=500){limited=true;break;}await walk(queue[i].dir,queue[i].depth);if(visited%50===0)onProgress({phase:'discovering',completed:visited,total:0,label:'已检查 '+visited+' 个目录，发现 '+found.length+' 个项目'});}if(limited)warnings.push('本次根目录及一级文件夹扫描因目录数量、500 项目或 120 秒安全预算未完成；未扫描部分请手动补充。');
 return {repositories:found.sort((a,b)=>a.path.localeCompare(b.path)),warnings,visited,limits:{maxDepth,maxDirectories},limited};
}
export async function collect(cwd,request,signal,onProgress=()=>{}){
 if(!request||!Array.isArray(request.repositories)||!request.repositories.length||request.repositories.length>12)throw new Error('请选择 1–12 个项目');
 if(request.contextPaths!==undefined&&(!Array.isArray(request.contextPaths)||request.contextPaths.length>20))throw new Error('最多附带 20 个源码文件');
 const result={title:typeof request.title==='string'?request.title.slice(0,160):'版本发布报告',createdAt:new Date().toISOString(),repositories:[],context:[],limitations:['差异仅比较两个版本端点，不包含未提交修改；Git 子模块仅记录指针变化，不递归分析。','源码上下文为显式选择的当前工作区文件，不代表版本 A 或 B；未执行测试。','影响分析不是完整调用图；二进制、LFS 内容及未提供源码的行为需要人工验证。']};
 const total=request.repositories.length+(request.contextPaths||[]).length;let completed=0;
 onProgress({phase:'collecting',completed,total,label:'准备读取版本差异'});
 for(const row of request.repositories){
  onProgress({phase:'collecting',completed,total,label:'读取项目：'+row.path});
  signal?.throwIfAborted();if(!row||!['git','svn'].includes(row.type))throw new Error('仅支持 Git / SVN');
  const requested=side=>{const value=row[side];if(typeof value!=='string')throw new Error('版本必须是文本，留空表示分支最新提交');return value.trim();};
  const versionA=requested('a'),versionB=requested('b');
  const root=await inside(cwd,row.path,{root:true}),a=row.type==='svn'?(versionA?svnRevision(versionA):'HEAD'):revision(versionA||row.branchA,'git'),b=row.type==='svn'?(versionB?svnRevision(versionB):'HEAD'):revision(versionB||row.branchB,'git');
  const exec=(cmd,args)=>run(cmd,args,{cwd:root,signal});let repo={path:row.path||'.',type:row.type,a,b};
  if(row.type==='git'){
   const top=(await exec('git',['rev-parse','--show-toplevel'])).trim();if(await realpath(top)!==await realpath(root))throw new Error('请指定 Git 仓库根目录');
   const resolve=async ref=>{const id=(await exec('git',['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).trim();if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))throw new Error('无法解析提交');return id;};
   repo.a=await resolve(a);repo.b=await resolve(b);
   repo.files=(await exec('git',['diff','--no-color','--no-ext-diff','--no-textconv','--ignore-submodules=none','--no-renames','--name-only','-z',repo.a,repo.b,'--'])).split('\0').filter(Boolean);
   repo.excludedPaths=repo.files.filter(internalPath);repo.files=repo.files.filter(p=>!internalPath(p));
   if(repo.files.some(secretPath))throw new Error('项目 '+repo.path+' 差异包含敏感路径：'+repo.files.filter(secretPath).join('、'));
   const exclusions=repo.excludedPaths.length?[':(exclude,icase,glob)**/.git',':(exclude,icase,glob)**/.git/**',':(exclude,icase,glob)**/.svn',':(exclude,icase,glob)**/.svn/**']:[];
   repo.diff=await exec('git',['-c','core.quotePath=false','diff','--no-color','--no-ext-diff','--no-textconv','--ignore-submodules=none','--no-renames','--submodule=short','--unified=3',repo.a,repo.b,'--',...exclusions]);
   repo.summary=await exec('git',['diff','--no-color','--no-ext-diff','--no-textconv','--ignore-submodules=none','--stat',repo.a,repo.b,'--',...exclusions]);
  }else{
   if(request.allowSvnNetwork!==true)throw new Error('SVN 历史读取需要勾选仓库访问授权');
   const branchA=svnBranch(row.branchA),branchB=svnBranch(row.branchB);
   const info=xml(await exec('svn',['info','--xml','--non-interactive','--',root+'@'])).info.entry;
   if(!info?.url||!info.repository?.uuid||!info.repository?.root||!info['wc-info'])throw new Error('需要 SVN 工作副本目录');
   repo.a=a;repo.b=b;repo.branchA=branchA;repo.branchB=branchB;
   const urlA=branchUrl(info.repository.root,info.url,branchA),urlB=branchUrl(info.repository.root,info.url,branchB);
   const args=['--non-interactive','--no-auth-cache'];
   const resolve=async(url,rev)=>{
    const endpoint=xml(await exec('svn',['info','--xml','-r',rev,...args,'--',url+'@'+rev])).info.entry;
    if(endpoint?.repository?.uuid!==info.repository.uuid||endpoint?.repository?.root!==info.repository.root)throw new Error('SVN 分支不属于同一仓库');
    if(rev!=='HEAD')return rev;
    const head=svnRevision(endpoint['@_revision']);
    const entries=list(xml(await exec('svn',['log','--xml','--limit','1','-r',head+':0',...args,'--',url+'@'+head])).log?.logentry);
    if(entries.length!==1)throw new Error('无法解析 SVN 分支最新提交');
    return svnRevision(entries[0]['@_revision']);
   };
   repo.a=await resolve(urlA,a);repo.b=await resolve(urlB,b);
   repo.identity={uuid:info.repository.uuid,repositoryRoot:info.repository.root,urlA,urlB};
   const targets=['--old='+urlA+'@'+repo.a,'--new='+urlB+'@'+repo.b];
   const changes=xml(await exec('svn',['diff','--summarize','--xml',...targets,...args]));
   const entries=list(changes.diff?.paths?.path).map(x=>{
    const name=typeof x==='string'?x:x['#text'];
    const base=[urlA,urlB].find(url=>name===url||name.startsWith(url+'/'));
    if(!base)throw new Error('SVN 变更路径不属于比较端点');
    const relative=decodeURIComponent(name.slice(base.length).replace(/^\//,''));
    if(relative.split('/').some(p=>p==='..'||p==='.')||relative.includes('\\'))throw new Error('无效 SVN 变更路径');
    return {relative,kind:x['@_kind']};
   });
   repo.excludedPaths=entries.filter(x=>internalPath(x.relative)).map(x=>x.relative);
   const included=entries.filter(x=>!internalPath(x.relative));repo.files=included.map(x=>x.relative);
   if(repo.files.some(secretPath))throw new Error('项目 '+repo.path+' 差异包含敏感路径：'+repo.files.filter(secretPath).join('、'));
   if(!repo.excludedPaths.length)repo.diff=await exec('svn',['diff','--internal-diff',...targets,...args]);
   else{
    // Never request a recursive parent diff after exclusions: deleted directories contain old bodies too.
    repo.diff='';
    for(const entry of included){
     if(!['file','dir'].includes(entry.kind))throw new Error('无法安全判断 SVN 变更类型');
     const suffix=entry.relative?'/'+entry.relative.split('/').map(encodeURIComponent).join('/'):'';
     repo.diff+=await exec('svn',['diff','--internal-diff','--depth','empty','--old='+urlA+suffix+'@'+repo.a,'--new='+urlB+suffix+'@'+repo.b,...args]);
     if(Buffer.byteLength(repo.diff)>1024*1024)throw new Error('报告证据超过 1 MiB；请分批比较，未静默截断');
    }
   }
   repo.summary=repo.files.join('\n');
  }
  if(repo.excludedPaths?.length)result.limitations.push('项目 '+repo.path+' 已在正文读取前排除 '+repo.excludedPaths.length+' 条 .git / .svn 内部路径记录；未读取其正文，不属于本报告分析覆盖。');
  repo.requestedA=a;repo.requestedB=b;repo.diffHash=hash(repo.diff);result.repositories.push(repo);onProgress({phase:'collecting',completed:++completed,total,label:'项目差异已采集：'+row.path});
 }
 for(const name of request.contextPaths||[]){onProgress({phase:'collecting',completed,total,label:'读取源码：'+name});const file=await regular(cwd,name);const handle=await open(file,'r');let buf;try{const stat=await handle.stat();if(stat.size>128*1024)throw new Error('单个源码文件不能超过 128 KiB');const buffer=Buffer.alloc(128*1024+1);let offset=0;while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}buf=buffer.subarray(0,offset);}finally{await handle.close();}if(buf.length>128*1024||buf.includes(0))throw new Error('源码文件过大或为二进制');result.context.push({path:name,provenance:'current-workspace',hash:hash(buf),text:new TextDecoder('utf-8',{fatal:true}).decode(buf)});onProgress({phase:'collecting',completed:++completed,total,label:'源码已采集：'+name});}
 if(Buffer.byteLength(JSON.stringify(result))>1024*1024)throw new Error('报告证据超过 1 MiB；请分批比较，未静默截断');
 return result;
}
