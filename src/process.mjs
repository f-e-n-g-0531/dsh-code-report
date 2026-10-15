import {spawn} from 'node:child_process';
export function run(command,args,{cwd,signal,maxBytes=4*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const child=spawn(command,args,{cwd,signal,shell:false,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}});
    let bytes=0,out=[],err=[],failure;
    const timer=setTimeout(()=>{failure=new Error('命令超时（60 秒）');child.kill();},60000);
    const take=target=>chunk=>{bytes+=chunk.length;if(bytes>maxBytes){failure=new Error('命令输出超出采集上限，未生成不完整报告');child.kill();}else target.push(chunk);};
    child.stdout.on('data',take(out));child.stderr.on('data',take(err));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(failure)return reject(failure);if(code!==0)return reject(new Error(command+' 读取失败: '+Buffer.concat(err).toString('utf8').slice(0,1200)));resolve(Buffer.concat(out).toString('utf8'));});
  });
}
