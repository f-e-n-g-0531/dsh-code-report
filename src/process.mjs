import {spawn} from 'node:child_process';
const COMMAND_TIMEOUT_MS=60000;
const DEFAULT_MAX_BYTES=4*1024*1024;
export function isolatedEnvironment(source=process.env){const env=Object.fromEntries(Object.entries(source).filter(([key])=>!/^GIT_/i.test(key)));return {...env,GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'};}
function decodeUtf8(bytes){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
export function run(command,args,{cwd,signal,maxBytes=DEFAULT_MAX_BYTES}={}) {
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const child=spawn(command,args,{cwd,signal,shell:false,windowsHide:true,env:isolatedEnvironment()});
    let bytes=0,out=[],err=[],failure;
    const timer=setTimeout(()=>{failure=new Error('命令超时（60 秒）');child.kill();},COMMAND_TIMEOUT_MS);
    const take=target=>chunk=>{bytes+=chunk.length;if(bytes>maxBytes){failure=new Error('命令输出超出采集上限，未生成不完整报告');child.kill();}else target.push(chunk);};
    child.stdout.on('data',take(out));child.stderr.on('data',take(err));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(failure)return reject(failure);if(code!==0)return reject(new Error(command+' 读取失败: '+Buffer.concat(err).toString('utf8').slice(0,1200)));try{resolve(decodeUtf8(Buffer.concat(out)));}catch{reject(new Error(command+' 输出不是有效 UTF-8，已停止采集；可能包含 GBK/GB18030 等编码，请转换或拆分范围后重试，未生成乱码报告'));}});
  });
}
