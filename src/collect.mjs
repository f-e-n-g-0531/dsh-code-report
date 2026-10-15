import path from 'node:path';
import {realpath,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {inside,regular,secretPath} from './paths.mjs';
import {run} from './process.mjs';
const xml=text=>{if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)throw new Error('无效 SVN XML');return new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false}).parse(text);};
const list=x=>x===undefined?[]:Array.isArray(x)?x:[x];
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function revision(value,type){if(typeof value!=='string'||!value||value.length>256||/[\x00-\x20]/.test(value)||value.startsWith('-')||(type==='svn'&&!/^\d+$/.test(value)))throw new Error(type==='svn'?'SVN 版本必须是固定数字':'无效 Git 版本');return value;}
export async function discover(cwd,signal){
 const {readdir}=await import('node:fs/promises');const found=[],warnings=[];let visited=0;
 async function walk(dir,depth){signal?.throwIfAborted();if(++visited>300){warnings.push('发现扫描达到 300 目录上限，可手动填写项目路径');return;}const entries=await readdir(dir,{withFileTypes:true});const type=entries.some(x=>x.name==='.git')?'git':entries.some(x=>x.name==='.svn')?'svn':null;if(type)found.push({path:path.relative(cwd,dir).split(path.sep).join('/')||'.',type});if(depth>=3)return;for(const e of entries)if(e.isDirectory()&&!e.isSymbolicLink()&&!/^(\.|node_modules$|dist$|build$)/.test(e.name)&&visited<300)await walk(path.join(dir,e.name),depth+1);}
 await walk(cwd,0);if(visited>=300)warnings.push('发现扫描达到 300 目录上限，可手动填写遗漏项目');return {repositories:found,warnings};
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
  const root=await inside(cwd,row.path,{root:true}),a=revision(row.a,row.type),b=revision(row.b,row.type);
  const exec=(cmd,args)=>run(cmd,args,{cwd:root,signal});let repo={path:row.path||'.',type:row.type,a,b};
  if(row.type==='git'){
   const top=(await exec('git',['rev-parse','--show-toplevel'])).trim();if(await realpath(top)!==await realpath(root))throw new Error('请指定 Git 仓库根目录');
   const resolve=async ref=>{const id=(await exec('git',['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).trim();if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))throw new Error('无法解析提交');return id;};
   repo.a=await resolve(a);repo.b=await resolve(b);
   repo.files=(await exec('git',['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',repo.a,repo.b,'--'])).split('\0').filter(Boolean);
   if(repo.files.some(secretPath))throw new Error('差异包含敏感路径，请拆分发布范围后重试');
   repo.diff=await exec('git',['-c','core.quotePath=false','diff','--no-ext-diff','--no-textconv','--no-renames','--submodule=short','--unified=3',repo.a,repo.b,'--']);
   repo.summary=await exec('git',['diff','--no-ext-diff','--no-textconv','--stat',repo.a,repo.b,'--']);
  }else{
   if(request.allowSvnNetwork!==true)throw new Error('SVN 历史读取需要勾选仓库访问授权');
   if(BigInt(a)>BigInt(b))throw new Error('SVN 版本 B 不得小于版本 A');
   const info=xml(await exec('svn',['info','--xml','--non-interactive','--',root+'@'])).info.entry;
   if(!info?.url||!info.repository?.uuid||!info['wc-info'])throw new Error('需要 SVN 工作副本目录');
   const url=info.url;repo.identity={uuid:info.repository.uuid,url};
   const args=['--non-interactive','--no-auth-cache'];const target=url+'@'+b;
   repo.a=String(BigInt(a));repo.b=String(BigInt(b));
   const changes=xml(await exec('svn',['diff','--summarize','--xml','-r',repo.a+':'+repo.b,...args,'--',target]));
   repo.files=list(changes.diff?.paths?.path).map(x=>typeof x==='string'?x:x['#text']);
   if(repo.files.some(secretPath))throw new Error('差异包含敏感路径');
   repo.diff=await exec('svn',['diff','--internal-diff','-r',repo.a+':'+repo.b,...args,'--',target]);repo.summary=repo.files.join('\n');
  }
  repo.requestedA=a;repo.requestedB=b;repo.diffHash=hash(repo.diff);result.repositories.push(repo);onProgress({phase:'collecting',completed:++completed,total,label:'项目差异已采集：'+row.path});
 }
 for(const name of request.contextPaths||[]){onProgress({phase:'collecting',completed,total,label:'读取源码：'+name});const file=await regular(cwd,name);const handle=await open(file,'r');let buf;try{const stat=await handle.stat();if(stat.size>128*1024)throw new Error('单个源码文件不能超过 128 KiB');const buffer=Buffer.alloc(128*1024+1);let offset=0;while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}buf=buffer.subarray(0,offset);}finally{await handle.close();}if(buf.length>128*1024||buf.includes(0))throw new Error('源码文件过大或为二进制');result.context.push({path:name,provenance:'current-workspace',hash:hash(buf),text:new TextDecoder('utf-8',{fatal:true}).decode(buf)});onProgress({phase:'collecting',completed:++completed,total,label:'源码已采集：'+name});}
 if(Buffer.byteLength(JSON.stringify(result))>1024*1024)throw new Error('报告证据超过 1 MiB；请分批比较，未静默截断');
 return result;
}
