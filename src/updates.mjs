import {readFileSync} from 'node:fs';
import {PACKAGE_NAME,PROTOCOL_VERSION,stableVersion,newerVersion} from './protocol.mjs';
// Capture once: installing files must not relabel the still-running old host.
export const RUNNING_VERSION=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
export function runtimeInfo(){return {packageName:PACKAGE_NAME,runningVersion:RUNNING_VERSION,protocol:PROTOCOL_VERSION};}
export async function checkUpdate({fetcher=fetch,signal}={}){
 const response=await fetcher('https://registry.npmjs.org/@feng0531%2fdsh-code-report/latest',{redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)])});
 if(!response.ok)throw new Error('无法查询 npm 最新版本（HTTP '+response.status+'）');
 if(Number(response.headers.get('content-length'))>256*1024)throw new Error('版本信息过大');
 const reader=response.body.getReader();let bytes=0;const chunks=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>256*1024)throw new Error('版本信息过大');chunks.push(value);}}finally{await reader.cancel();reader.releaseLock();}
 const meta=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(meta.name!==PACKAGE_NAME||!stableVersion(meta.version)||!meta.dsh?.bundle)throw new Error('npm 返回的插件信息无效');
 return {...runtimeInfo(),latestVersion:meta.version,available:newerVersion(meta.version,RUNNING_VERSION),registry:'https://registry.npmjs.org/',releaseUrl:'https://github.com/f-e-n-g-0531/dsh-code-report/releases/tag/v'+meta.version};
}
