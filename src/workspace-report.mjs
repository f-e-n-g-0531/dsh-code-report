import path from 'node:path';
import {open,lstat,realpath,mkdir,link,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {reportDownloadText} from './report-export.mjs';

const directoryName='dsh-code-report-reports';
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const failure=()=>Object.assign(new Error('报告保存失败，请检查当前会话工作目录后重试'),{code:'code-report/report-save'});

// Check each component as well as the canonical result: resolving first alone
// would silently accept a symlink/junction supplied as the workspace root.
async function directory(target){
  const parsed=path.parse(target);let current=parsed.root;
  for(const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    const stat=await lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw failure();
  }
  const stat=await lstat(target),canonical=await realpath(target);
  if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(target,canonical)!=='')throw failure();
  return stat;
}

export async function saveWorkspaceReport(cwd,markdown,{assertCurrent=async()=>{}}={}){
  let handle,temp,published,owned,base,folder,baseStat,folderStat;
  async function checkDirectories(){
    if(!sameFile(baseStat,await directory(base))||!sameFile(folderStat,await directory(folder)))throw failure();
  }
  async function removeOwn(file){
    if(!file||!owned)return;
    await checkDirectories();
    const stat=await lstat(file);
    if(stat.isFile()&&!stat.isSymbolicLink()&&sameFile(stat,owned))await unlink(file);
  }
  try{
    if(typeof cwd!=='string'||!path.isAbsolute(cwd)||cwd.includes('\0')||typeof markdown!=='string')throw failure();
    await assertCurrent();
    base=path.resolve(cwd);baseStat=await directory(base);base=await realpath(base);
    folder=path.join(base,directoryName);
    if(path.relative(base,folder)!==directoryName)throw failure();
    try{await mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    folderStat=await directory(folder);await checkDirectories();
    const filename='release-report-'+new Date().toISOString().replace(/:/g,'-')+'-'+randomUUID()+'.md';
    const target=path.join(folder,filename),candidate=path.join(folder,'.'+filename+'.'+randomUUID()+'.tmp');
    handle=await open(candidate,'wx',0o600);temp=candidate;owned=await handle.stat();
    if(!owned.isFile()||owned.nlink!==1)throw failure();
    await handle.writeFile(reportDownloadText(markdown,'analysis'),'utf8');
    await handle.sync();await handle.close();handle=null;
    await assertCurrent();await checkDirectories();
    const staged=await lstat(temp);
    if(!staged.isFile()||staged.isSymbolicLink()||staged.nlink!==1||!sameFile(staged,owned))throw failure();
    // A hard link publishes only complete, synced bytes and refuses ALL existing
    // destinations (including symlinks); unlike rename it cannot overwrite.
    await link(temp,target);published=target;
    await removeOwn(temp);temp=null;
    return {status:'saved',path:target};
  }catch{
    await handle?.close().catch(()=>{});handle=null;
    await removeOwn(published).catch(()=>{});
    await removeOwn(temp).catch(()=>{});
    // Never forward filesystem paths, report contents or callback exceptions.
    throw failure();
  }
}
