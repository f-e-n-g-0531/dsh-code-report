import path from 'node:path';
import {constants} from 'node:fs';
import {open,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {cleanConfiguration} from './configuration.mjs';

export const WORKSPACE_CONFIGURATION_FILENAME='.dsh-code-report.json';
function problem(code,message){return Object.assign(new Error(message),{code:'code-report/configuration-'+code});}
function safeError(error,action){
  if(typeof error?.code==='string'&&error.code.startsWith('code-report/'))return error;
  if(error?.name==='AbortError'||error?.name==='TimeoutError')return problem('cancelled','配置操作已取消');
  const reason=['EACCES','EPERM','EROFS'].includes(error?.code)?'权限不足或工作目录只读':error?.code==='ENOENT'?'工作目录或配置文件已变化':error?.code==='ENOSPC'?'磁盘空间不足':'文件系统操作失败';
  return problem('io',action+'失败：'+reason+'；请检查当前会话工作目录');
}
function clean(value){try{return cleanConfiguration(value);}catch{throw problem('invalid','配置格式或字段无效，请检查配置后重试');}}
async function root(cwd){
  if(typeof cwd!=='string'||!path.isAbsolute(cwd)||cwd.includes('\0'))throw problem('workspace','当前会话工作目录无效');
  const base=await realpath(cwd);
  if(!(await lstat(base)).isDirectory())throw problem('workspace','当前会话工作目录不是目录');
  return base;
}
async function checkRoot(base){if(await realpath(base)!==base||!(await lstat(base)).isDirectory())throw problem('unsafe-path','工作目录链接已变化，配置操作已停止');}
async function targetStat(target){
  let stat;try{stat=await lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  // Never follow even an in-workspace symlink; a save must not overwrite linked data.
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw problem('unsafe-path','配置文件必须是工作目录根下的普通独立文件，不能是链接或目录');
  return stat;
}
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
// Windows rename may fail while another request has the destination open. Serialize
// this backend's readers and writers per canonical root, including root aliases.
const pending=new Map();
async function inWorkspace(cwd,signal,action,body){
  try{
    signal?.throwIfAborted();const base=await root(cwd),prior=pending.get(base)??Promise.resolve();
    const result=prior.then(()=>{signal?.throwIfAborted();return body(base);});
    const settled=result.then(()=>{},()=>{});pending.set(base,settled);
    try{return await result;}finally{if(pending.get(base)===settled)pending.delete(base);}
  }catch(error){throw safeError(error,action);}
}
export function loadWorkspaceConfiguration(cwd,options={}){return inWorkspace(cwd,options.signal,'加载配置',base=>loadConfigurationFile(base,options));}
export function saveWorkspaceConfiguration(cwd,value,options={}){return inWorkspace(cwd,options.signal,'保存配置',base=>saveConfigurationFile(base,value,options));}
async function loadConfigurationFile(cwd,{signal,assertCurrent=async()=>{}}={}){
  let handle;
  try{
    signal?.throwIfAborted();const base=cwd,target=path.join(base,WORKSPACE_CONFIGURATION_FILENAME);await checkRoot(base);
    const before=await targetStat(target);
    if(!before){await assertCurrent();signal?.throwIfAborted();return null;}
    handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const opened=await handle.stat(),after=await targetStat(target);
    await checkRoot(base);
    if(!opened.isFile()||!after||!sameFile(before,opened)||!sameFile(after,opened))throw problem('unsafe-path','配置文件在读取时发生变化，请重试');
    let parsed;try{parsed=JSON.parse(await handle.readFile({encoding:'utf8',signal}));}catch(error){if(error instanceof SyntaxError)throw problem('invalid','配置文件不是有效 JSON，请修复或移走配置文件后重试');throw error;}
    const value=clean(parsed);await assertCurrent();signal?.throwIfAborted();return value;
  }catch(error){throw safeError(error,'加载配置');}finally{await handle?.close();}
}
async function saveConfigurationFile(cwd,value,{signal,assertCurrent=async()=>{}}={}){
  let handle,temp;
  try{
    signal?.throwIfAborted();const configuration=clean(value),base=cwd,target=path.join(base,WORKSPACE_CONFIGURATION_FILENAME);
    await targetStat(target);await checkRoot(base);
    temp=path.join(base,WORKSPACE_CONFIGURATION_FILENAME+'.'+randomUUID()+'.tmp');
    handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
    await handle.writeFile(JSON.stringify(configuration,null,2)+'\n',{encoding:'utf8',signal});
    await handle.sync();await handle.close();handle=null;
    await assertCurrent();signal?.throwIfAborted();await checkRoot(base);await targetStat(target);
    // Same-directory rename publishes a complete file; failure leaves the old config intact.
    await rename(temp,target);temp=null;return configuration;
  }catch(error){throw safeError(error,'保存配置');}finally{
    await handle?.close();if(temp)await unlink(temp).catch(()=>{});
  }
}
