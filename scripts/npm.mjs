import {spawnSync} from 'node:child_process';
export function npm(args,cwd=process.cwd()){
 const cli=process.env.npm_execpath;if(!cli||!cli.replaceAll(String.fromCharCode(92),'/').endsWith('/npm-cli.js'))throw new Error('Run using npm run (not pnpm)');
 const r=spawnSync(process.execPath,[cli,...args],{cwd,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:16*1024*1024});if(r.error)throw r.error;if(r.status!==0)throw new Error(r.stderr||r.stdout||'npm failed');return r.stdout;
}
