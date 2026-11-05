import test from 'node:test';import assert from 'node:assert/strict';import {ensureNpm,ensureGithub,createNpmLookup} from '../scripts/release-core.mjs';
const bytes=Buffer.from('original CI artifact');

// Execute the actual workflow selector instead of reimplementing its policy.
async function selectTestedArtifact(artifacts,attempt=2){
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const script=source.match(/          script: \|\r?\n((?:            .*\r?\n)+)/)?.[1];
 assert.ok(script,'workflow artifact selector exists');
 let selected;
 const listWorkflowRunArtifacts=()=>{};
 const github={rest:{actions:{listWorkflowRunArtifacts}},paginate:async(method,options)=>{
  assert.equal(method,listWorkflowRunArtifacts);
  assert.deepEqual(options,{owner:'fixture',repo:'report',run_id:123,per_page:100});
  return artifacts;
 }};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction('github','context','core','process',script.replace(/^            /gm,''))(
  github,{repo:{owner:'fixture',repo:'report'},runId:123,sha:'a'.repeat(40)},
  {setOutput:(key,value)=>{assert.equal(key,'artifact-id');selected=value;}},
  {env:{GITHUB_RUN_ATTEMPT:String(attempt)}});
 return selected;
}
const matrixArtifact=(attempt,id=attempt)=>({id,name:'package-ubuntu-latest-node-24-attempt-'+attempt,expired:false,workflow_run:{head_sha:'a'.repeat(40)}});

test('failed-only release retry reuses matrix bytes when no matrix lane reruns',async()=>{
 const original={...matrixArtifact(1,101),bytes};
 const artifacts=[original,{id:102,name:'browser-evidence-123-attempt-1'},
  {id:103,name:'release-v1.0.0-123-attempt-1'}];
 const snapshot=artifacts.map(a=>({...a,...(a.bytes?{bytes:Buffer.from(a.bytes)}:{}),...(a.workflow_run?{workflow_run:{...a.workflow_run}}:{})}));
 const selected=await selectTestedArtifact(artifacts,2);
 assert.equal(selected,'101');
 let publishes=0;
 assert.equal(await ensureNpm({archive:artifacts.find(a=>String(a.id)===selected).bytes,
  lookup:async()=>({state:'ready',bytes}),publish:async()=>publishes++}),'existing');
 assert.equal(publishes,0);
 assert.deepEqual(artifacts,snapshot,'the original package and preserved evidence remain untouched');
});

test('full rerun preserves original package identity after partial publishing, regardless of API order',async()=>{
 const artifacts=[matrixArtifact(3,303),matrixArtifact(2,202),matrixArtifact(1,101),
  {...matrixArtifact(1,404),name:'package-windows-latest-node-24-attempt-1'},
  {...matrixArtifact(1,405),name:'package-ubuntu-latest-node-22-attempt-1'},
  {...matrixArtifact(1,406),name:'package-ubuntu-latest-node-24-attempt-1-extra'}];
 assert.equal(await selectTestedArtifact(artifacts,3),'101');
 assert.equal(await selectTestedArtifact([...artifacts].reverse(),3),'101');
 // A lane first passing on attempt 2 has no attempt-1/current-attempt package.
 assert.equal(await selectTestedArtifact([matrixArtifact(3),matrixArtifact(2)],3),'2');
 assert.equal(await selectTestedArtifact([matrixArtifact(1)],1),'1');
});

test('selector fails closed for missing, future, different SHA or expired originals',async()=>{
 for(const artifacts of [[],[matrixArtifact(3)],
  [{...matrixArtifact(1),expired:true},matrixArtifact(2)],
  [{...matrixArtifact(1),workflow_run:{head_sha:'b'.repeat(40)}}],
  [{id:5,name:'browser-evidence-123-attempt-2'}]]){
  await assert.rejects(selectTestedArtifact(artifacts,2),/No original tested matrix package/);
 }
});

test('npm existing identical version skips publish, mismatch and HTTP errors fail closed',async()=>{let calls=0;const publish=async()=>{calls++;};assert.equal(await ensureNpm({archive:bytes,lookup:async()=>({state:'ready',bytes}),publish}),'existing');assert.equal(calls,0);await assert.rejects(ensureNpm({archive:bytes,lookup:async()=>({state:'ready',bytes:Buffer.from('different')}),publish}),/mismatch/);await assert.rejects(ensureNpm({archive:bytes,lookup:async()=>{throw new Error('503');},publish}),/503/);assert.equal(calls,0);});
test('npm publish waits for propagation and can resume after timeout without republish',async()=>{let published=false,calls=0;const publish=async()=>{published=true;calls++;};await assert.rejects(ensureNpm({archive:bytes,lookup:async()=>({state:'absent'}),publish,attempts:2,wait:async()=>{}}),/not visible/);assert.equal(published,true);assert.equal(await ensureNpm({archive:bytes,lookup:async()=>({state:'ready',bytes}),publish}),'existing');assert.equal(calls,1);});
test('metadata exists while tarball is delayed never republishes, even if metadata later regresses to 404',async()=>{const pkg={name:'fixture',version:'1.0.0'};const responses=[Response.json({...pkg,dist:{tarball:'https://registry.npmjs.org/pkg.tgz'}}),new Response('',{status:404}),new Response('',{status:404}),Response.json({...pkg,dist:{tarball:'https://registry.npmjs.org/pkg.tgz'}}),new Response(bytes)];let publishes=0;const lookup=createNpmLookup(pkg,async()=>{assert.ok(responses.length);return responses.shift();});assert.equal(await ensureNpm({lookup,archive:bytes,publish:async()=>publishes++,wait:async()=>{},attempts:3}),'existing');assert.equal(publishes,0);});
test('tarball delay timeout never republishes an existing version',async()=>{const pkg={name:'fixture',version:'1.0.0'};let publishes=0;const lookup=createNpmLookup(pkg,async url=>String(url).endsWith('.tgz')?new Response('',{status:404}):Response.json({...pkg,dist:{tarball:'https://registry.npmjs.org/pkg.tgz'}}));await assert.rejects(ensureNpm({lookup,archive:bytes,publish:async()=>publishes++,wait:async()=>{},attempts:3}),/not visible/);assert.equal(publishes,0);});
test('registry adapter never maps authentication or server errors to absent',async()=>{for(const status of [401,403,500]){const lookup=createNpmLookup({name:'fixture',version:'1'},async()=>new Response('',{status}));await assert.rejects(lookup,/metadata status/);}});
function fixture(){let release=null,id=0;const assets=[];const files=[{name:'package.tgz',bytes},{name:'SHA256SUMS.txt',bytes:Buffer.from('checksum')}];const options={tag:'v1.0.0',sha:'a'.repeat(40),files,lookup:async()=>release,create:async()=>{release={id:1,tag_name:'v1.0.0',prerelease:false,draft:true};return release;},listAssets:async()=>assets,download:async a=>a.bytes,upload:async(r,f)=>{const a={id:++id,...f};assets.push(a);return a;},finalize:async()=>{release.draft=false;}};return {options,assets,getRelease:()=>release};}
test('GitHub create and repeated run verify assets without duplicate upload',async()=>{const f=fixture();await ensureGithub(f.options);assert.equal(f.assets.length,2);assert.equal(f.getRelease().draft,false);await ensureGithub(f.options);assert.equal(f.assets.length,2);});
test('GitHub partial upload resumes draft and only uploads missing bytes',async()=>{const f=fixture();const upload=f.options.upload;let count=0;f.options.upload=async(...args)=>{if(++count===2)throw new Error('transport');return upload(...args);};await assert.rejects(ensureGithub(f.options),/transport/);assert.equal(f.getRelease().draft,true);assert.equal(f.assets.length,1);f.options.upload=upload;await ensureGithub(f.options);assert.equal(f.assets.length,2);assert.equal(f.getRelease().draft,false);});
test('GitHub mismatched existing asset is never overwritten or followed by uploads',async()=>{const f=fixture();await f.options.create();f.assets.push({name:'package.tgz',bytes:Buffer.from('wrong')});await assert.rejects(ensureGithub(f.options),/mismatch/);assert.equal(f.assets.length,1);assert.equal(f.getRelease().draft,true);});
