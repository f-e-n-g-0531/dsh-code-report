import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

// Hash build inputs, not timestamps or absolute paths. Any source edit requires a rebuild.
export async function sourceProvenance(root=process.cwd()){
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 const sources=(await readdir(path.join(root,'src'))).filter(name=>/\.(?:mjs|jsx|css)$/.test(name)).map(name=>'src/'+name);
 const names=['build.mjs','scripts/provenance.mjs','index.mjs','package.json','package-lock.json',...sources].sort();
 const inputs=[];
 for(const name of names)inputs.push({path:name,sha256:sha256(await readFile(path.join(root,name)))});
 return {schema:1,version:pkg.version,sourceHash:sha256(JSON.stringify(inputs)),inputs};
}

export async function verifyBuild(root=process.cwd()){
 const expected=await sourceProvenance(root);
 const actual=JSON.parse(await readFile(path.join(root,'dist/build-provenance.json'),'utf8'));
 assert.equal(actual.schema,1,'Unsupported build provenance');
 assert.equal(actual.version,expected.version,'Stale client version: run npm run build');
 assert.equal(actual.sourceHash,expected.sourceHash,'Stale build inputs: run npm run build');
 assert.deepEqual(actual.inputs,expected.inputs,'Build input manifest mismatch');
 const client=await readFile(path.join(root,'dist/client.js'));
 assert.equal(actual.clientHash,sha256(client),'Client bytes do not match build provenance');
 const entry=loadClientEntry(client.toString('utf8'));
 assert.equal(entry.buildInfo?.version,expected.version,'Embedded client version mismatch');
 assert.equal(entry.buildInfo?.sourceHash,expected.sourceHash,'Embedded build source mismatch');
 return actual;
}

export function loadClientEntry(source){
 let entry;
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){assert.equal(entry,undefined,'Multiple client registrations');entry=value;}}}},{timeout:5000});
 assert.ok(entry&&typeof entry.factory==='function','Missing client factory');
 return entry;
}
