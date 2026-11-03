import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHandler} from '../src/host.mjs';
import {run} from '../src/process.mjs';

test('directory preview exposes exact expanded scope and analysis sends only the approved frozen files',async t=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'report-directory-host-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const root=path.join(cwd,'repo');await mkdir(root);const git=args=>run('git',args,{cwd:root});
 await git(['init']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
 await writeFile(path.join(root,'api.txt'),'baseline\n');await git(['add','.']);await git(['commit','-m','base']);
 const revision=(await git(['rev-parse','HEAD'])).trim();
 await mkdir(path.join(cwd,'context','nested'),{recursive:true});
 await writeFile(path.join(cwd,'context','api.ts'),'approved source');
 await writeFile(path.join(cwd,'context','nested','model.ts'),'approved nested');
 await writeFile(path.join(cwd,'context','.env'),'do not send secret');
 const inputs=[];const ctx={sessions:new Map([['s',{header:{cwd}}]]),llm:{async *stream(input){
  inputs.push(JSON.parse(input.messages[0].content[0].text));
  yield {type:'text-delta',text:JSON.stringify({changes:[],interfaces:[],impacts:[],qa:[],unknowns:[]})};
  yield {type:'finish',reason:{kind:'stop'}};
 }}};
 const handler=createHandler(ctx),request={repositories:[{path:'repo',type:'git',a:revision,b:revision}],contextPaths:['context']};
 const response=await handler('preview',{sessionId:'s',operationId:'directory-preview',request});
 assert.equal(response.ok,true,JSON.stringify(response));const p=response.value;
 assert.deepEqual(p.context.map(item=>item.path),['context/api.ts','context/nested/model.ts']);
 assert.ok(p.context.every(item=>item.provenance==='current-workspace'&&!Object.hasOwn(item,'text')&&/^[a-f0-9]{64}$/.test(item.hash)));
 assert.equal(inputs.length,0);assert.doesNotMatch(p.markdown,/do not send secret/);assert.ok(p.limitations.some(text=>/排除|跳过/.test(text)));
 const payload={sessionId:'s',operationId:'directory-consent',previewId:p.previewId,planId:p.analysisPlan.id,route:{provider:'fixture',model:'mock'},sendToModel:false};
 assert.equal((await handler('generate',payload)).error.code,'code-report/consent-required');assert.equal(inputs.length,0);
 await writeFile(path.join(cwd,'context','api.ts'),'changed after approval');await writeFile(path.join(cwd,'context','later.ts'),'unapproved new file');
 const generated=await handler('generate',{...payload,operationId:'directory-generate',sendToModel:true});assert.equal(generated.ok,true,JSON.stringify(generated));
 assert.ok(inputs.length>0);const serialized=JSON.stringify(inputs);assert.match(serialized,/approved source/);assert.match(serialized,/approved nested/);assert.doesNotMatch(serialized,/changed after approval|unapproved new file|do not send secret/);
});
