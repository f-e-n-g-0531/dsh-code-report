import path from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
export function relative(value,{root=false}={}) {
  if(typeof value!=='string'||(!value&&!root)||value.length>4096||/[\x00-\x1f:]/.test(value)||path.isAbsolute(value)||value.startsWith('\\')||value.split(/[\\/]/).includes('..'))throw new Error('路径必须位于当前工作区内');
  return value||'.';
}
export async function inside(cwd,value,options) {
  relative(value,options);const base=await realpath(cwd),target=await realpath(path.resolve(base,value||'.'));
  const rel=path.relative(base,target);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('路径或链接指向工作区外');
  return target;
}
export const internalPath=value=>/(^|[/\\])(?:\.git|\.svn)([/\\]|$)/i.test(value);
export const secretPath=value=>/(^|[/\\])(?:\.env(?:\..*)?|\.git|\.svn|node_modules|id_rsa|id_ed25519|credentials?)([/\\]|$)|\.(pem|key|p12|pfx)$/i.test(value);
export async function regular(cwd,value){if(secretPath(value))throw new Error('禁止采集凭据或仓库内部路径');const target=await inside(cwd,value);if(secretPath(path.relative(await realpath(cwd),target)))throw new Error('禁止采集凭据或仓库内部路径');if(!(await lstat(target)).isFile())throw new Error('源码上下文必须是普通文件');return target;}
