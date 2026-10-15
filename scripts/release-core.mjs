import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function sameBytes(actual,expected,label){assert.equal(digest(actual),digest(expected),label+' bytes mismatch; refuse overwrite');}
export async function ensureNpm({lookup,publish,archive,wait=()=>new Promise(r=>setTimeout(r,10000)),attempts=60}){
 const existing=await lookup();if(existing!==null){sameBytes(existing,archive,'npm');return 'existing';}
 await publish();for(let i=0;i<attempts;i++){const found=await lookup();if(found!==null){sameBytes(found,archive,'npm');return 'published';}if(i+1<attempts)await wait();}throw new Error('npm publication not visible; preserve original CI archive and rerun failed job');
}
export async function ensureGithub({lookup,create,listAssets,download,upload,finalize,files,tag,sha}){
 let release=await lookup();if(release){assert.equal(release.tag_name,tag);assert.equal(release.prerelease,false);}else release=await create({tag,sha});
 const assets=await listAssets(release);const missing=[];
 for(const file of files){const matches=assets.filter(a=>a.name===file.name);assert.ok(matches.length<=1,'duplicate release asset');if(matches.length)sameBytes(await download(matches[0]),file.bytes,'GitHub '+file.name);else missing.push(file);}
 for(const file of missing){const asset=await upload(release,file);sameBytes(await download(asset),file.bytes,'uploaded '+file.name);}
 if(release.draft)await finalize(release);return release;
}
