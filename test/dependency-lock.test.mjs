import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('XML naming lock metadata agrees with tarball identity and both parent constraints',async()=>{
 const lock=JSON.parse(await readFile('package-lock.json','utf8'));
 const entry=lock.packages['node_modules/xml-naming'];
 assert.equal(entry.version,'0.3.0');
 assert.equal(new URL(entry.resolved).pathname,'/xml-naming/-/xml-naming-'+entry.version+'.tgz');
 for(const parent of ['fast-xml-parser','fast-xml-builder'])assert.equal(lock.packages['node_modules/'+parent].dependencies['xml-naming'],'^0.3.0');
 const pnpm=await readFile('pnpm-lock.yaml','utf8');
 assert.ok(pnpm.includes('xml-naming@'+entry.version+':\n    resolution: {integrity: '+entry.integrity+'}'));
});
