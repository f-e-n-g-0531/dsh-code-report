import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function sameBytes(actual,expected,label){assert.equal(digest(actual),digest(expected),label+' bytes mismatch; refuse overwrite');}
export function createNpmLookup(pkg,request){return async()=>{
 const response=await request('https://registry.npmjs.org/'+encodeURIComponent(pkg.name)+'/'+pkg.version,{headers:{Accept:'application/json','Cache-Control':'no-cache'},redirect:'error'});
 if(response.status===404)return {state:'absent'};assert.equal(response.status,200,'npm metadata status');
 const meta=await response.json();assert.equal(meta.name,pkg.name);assert.equal(meta.version,pkg.version);const url=new URL(meta.dist.tarball);assert.equal(url.origin,'https://registry.npmjs.org');
 const result=await request(url,{headers:{'Cache-Control':'no-cache'},redirect:'error'});if(result.status===404)return {state:'pending'};assert.equal(result.status,200,'npm tarball status');return {state:'ready',bytes:Buffer.from(await result.arrayBuffer())};
};}
export async function waitForNpm({lookup,archive,initial,wait=()=>new Promise(r=>setTimeout(r,10000)),attempts=60}){
 let found=initial;for(let i=0;i<attempts;i++){if(!found)found=await lookup();assert.ok(['absent','pending','ready'].includes(found.state),'invalid npm lookup state');if(found.state==='ready'){sameBytes(found.bytes,archive,'npm');return;}console.log('Waiting for npm propagation',i+1,found.state);if(i+1<attempts)await wait();found=null;}throw new Error('npm publication not visible; preserve original CI archive and rerun failed job; do not republish blindly');
}
export async function ensureNpm(options){const {lookup,publish}=options;const existing=await lookup();assert.ok(['absent','pending','ready'].includes(existing.state),'invalid npm lookup state');const published=existing.state==='absent';if(published)await publish();await waitForNpm({...options,initial:published?undefined:existing});return published?'published':'existing';}

export async function ensureGithub({lookup,create,listAssets,download,upload,finalize,files,tag,sha}){
 let release=await lookup();if(release){assert.equal(release.tag_name,tag);assert.equal(release.prerelease,false);}else release=await create({tag,sha});
 const assets=await listAssets(release);const missing=[];
 for(const file of files){const matches=assets.filter(a=>a.name===file.name);assert.ok(matches.length<=1,'duplicate release asset');if(matches.length)sameBytes(await download(matches[0]),file.bytes,'GitHub '+file.name);else missing.push(file);}
 for(const file of missing){const asset=await upload(release,file);sameBytes(await download(asset),file.bytes,'uploaded '+file.name);}
 if(release.draft)await finalize(release);return release;
}
