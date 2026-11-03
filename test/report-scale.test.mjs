import test from 'node:test';
import assert from 'node:assert/strict';
import {markdown} from '../src/report.mjs';
test('report export preserves very large internal exclusion lists without argument spread ceilings',()=>{
 const excludedPaths=Array.from({length:150000},(_,i)=>'.git/internal-'+i);
 const report=markdown({title:'large release',createdAt:'fixed',context:[],limitations:[],repositories:[{path:'.',type:'git',requestedA:'a',requestedB:'b',a:'a',b:'b',files:[],diff:'',summary:'',diffHash:'hash',excludedPaths}]});
 assert.match(report,/internal-0/);assert.match(report,/internal-149999/);
 assert.equal(report.split('internal-').length-1,excludedPaths.length);
});
