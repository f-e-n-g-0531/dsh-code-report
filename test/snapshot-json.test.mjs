import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotJsonChunks,snapshotJsonBytes} from '../src/snapshot-json.mjs';
import {snapshotHash,evidenceHash} from '../src/evidence.mjs';
test('streamed snapshot preserves exact stringify bytes and hashes',()=>{
 const shared={n:1};
 for(const value of [{},{z:undefined,zero:0,no:false,n:null,nan:NaN,array:[undefined,-0,Infinity],skip:()=>{},s:Symbol()}, {text:'a'.repeat(16383)+'😀'+String.fromCharCode(0xd800)+'b'.repeat(17000)+String.fromCharCode(0xdc00),contexts:[{path:'中文',text:String.fromCharCode(34,92,10,0).repeat(20000)}]},[null,undefined,shared,shared],Object.assign(Object.create(null),{'10':1,'2':2,x:3})]){
 const expected=JSON.stringify(value);assert.equal([...snapshotJsonChunks(value)].join(''),expected);assert.equal(snapshotJsonBytes(value),Buffer.byteLength(expected));assert.equal(snapshotHash(value),evidenceHash(expected));
 }
});
test('large snapshot strings emit bounded chunks instead of giant JSON intermediates',()=>{const value={diff:'中'.repeat(1000000)},chunks=[...snapshotJsonChunks(value)];assert.ok(chunks.length>50);assert.ok(Math.max(...chunks.map(x=>Buffer.byteLength(x)))<100000);assert.equal(chunks.join(''),JSON.stringify(value));});
test('non-JSON objects and cycles fail explicitly',()=>{const circular={};circular.self=circular;assert.throws(()=>[...snapshotJsonChunks(circular)],/循环/);assert.throws(()=>[...snapshotJsonChunks(new Date())],/普通/);assert.throws(()=>[...snapshotJsonChunks({n:1n})],TypeError);});
