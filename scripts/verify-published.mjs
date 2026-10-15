import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createNpmLookup,waitForNpm,digest} from './release-core.mjs';
const pkg=JSON.parse(await readFile('package.json','utf8'));const [expected,name]=(await readFile('release/SHA256SUMS.txt','utf8')).trim().split(/\s+/);assert.match(name||'',/^[a-zA-Z0-9._-]+[.]tgz$/);const archive=await readFile('release/'+name);assert.equal(digest(archive),expected);
const request=(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(30000)});
await waitForNpm({lookup:createNpmLookup(pkg,request),archive});console.log('Registry artifact matches',name,expected);
