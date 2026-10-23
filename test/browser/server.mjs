import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

const harness=await build({entryPoints:['test/browser/harness.jsx'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const html='<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code Report browser fixture — simulated DSH</title><style>body{margin:0;font-family:system-ui}#fixture-controls{padding:8px;background:#eee}button,input,select,textarea{font:inherit}*{box-sizing:border-box}</style></head><body><nav id="fixture-controls" aria-label="测试宿主控制"></nav><main id="root"></main><script type="module" src="/harness.js"></script></body></html>';
const server=http.createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://127.0.0.1:4178').pathname;
  if(pathname==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('synthetic fixture');return;}
  if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'});res.end(html);return;}
  if(pathname==='/harness.js'){res.writeHead(200,{'Content-Type':'text/javascript;charset=utf-8'});res.end(harness.outputFiles[0].contents);return;}
  if(pathname==='/client.js'){res.writeHead(200,{'Content-Type':'text/javascript;charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(new URL('../../dist/client.js',import.meta.url)));return;}
  res.writeHead(404);res.end('not found');
 }catch(error){res.writeHead(500);res.end(error.message);}
});
server.listen(4178,'127.0.0.1',()=>console.log('Synthetic browser fixture http://127.0.0.1:4178 (not DSH GUI)'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
