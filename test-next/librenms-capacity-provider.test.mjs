import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LibreNmsCapacityProvider } from '../src/providers/librenms-capacity-provider.mjs';
import { LibreNmsProvider } from '../src/providers/librenms-provider-insights.mjs';
const raw={processor_id:2,device_id:1,processor_usage:55};
function setup({directory=[{sensor_id:2},{sensor_id:1}],row=raw,mode='',...options}={}){
 const calls=[];const client=new LibreNmsCapacityProvider({baseUrl:'http://localhost:8000',token:'synthetic-only-token',...options,fetchImpl:async(url,init)=>{
 calls.push({url:String(url),init});if(mode==='throw')throw new Error('SYNTHETIC-PRIVATE');if(mode==='oversize')return new Response('x'.repeat(2000),{headers:{'content-type':'application/json'}});if(mode==='redirect')return new Response(null,{status:302,headers:{location:'http://other.invalid'}});if(mode==='missing'||mode==='denied')return Response.json({private:'SYNTHETIC-PRIVATE'},{status:mode==='missing'?404:403});
 return Response.json(mode==='malformed'?{status:'ok'}:{status:'ok',graphs:String(url).endsWith('/processor')?directory:[{...row,processor_id:String(url).split('/').at(-1)}]});}});return{client,calls};}
test('fixed GET, stable numeric ordering and bounded page',async()=>{const{client,calls}=setup();const x=await client.readResourcePage('1','processor',{page:2,pageSize:1});assert.equal(x.total,2);assert.equal(x.items[0].id,'2');assert.equal(x.items[0].fields.usage_percent.value,55);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/devices/1/health/processor/2'));assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'error');assert.equal(x.observed_at,null);});
test('invalid argument and missing token cause no I/O',async()=>{const{client,calls}=setup();for(const[id,type,options]of[['../x','processor',{}],['1','lldp',{}],['1','processor',{pageSize:21}],['1','processor',{page:0}],['1','processor',{tenantId:'other'}]])await assert.rejects(client.readResourcePage(id,type,options),{code:'CAPACITY_INVALID_ARGUMENT'});assert.equal(calls.length,0);const empty=setup({token:''});await assert.rejects(empty.client.readResourcePage('1','processor'),{code:'CAPACITY_NOT_CONFIGURED'});assert.equal(empty.calls.length,0);});
test('true empty is distinct from malformed catalog',async()=>{const x=await setup({directory:[]}).client.readResourcePage('1','processor');assert.equal(x.total,0);assert.deepEqual(x.items,[]);await assert.rejects(setup({mode:'malformed'}).client.readResourcePage('1','processor'),{code:'CAPACITY_INVALID_RESPONSE'});});
test('duplicate, invalid and oversized directories fail',async()=>{for(const directory of [[{sensor_id:1},{sensor_id:1}],[{sensor_id:'../x'}],Array.from({length:101},(_,i)=>({sensor_id:i+1}))])await assert.rejects(setup({directory}).client.readResourcePage('1','processor'),{code:'CAPACITY_INVALID_RESPONSE'});});
test('cross-device records are rejected, not filtered',async()=>{await assert.rejects(setup({row:{...raw,device_id:2}}).client.readResourcePage('1','processor'),{code:'CAPACITY_SCOPE_MISMATCH'});});
test('redirect, byte limit and private upstream failures are controlled',async()=>{for(const mode of ['redirect','oversize','throw'])await assert.rejects(setup({mode,maxResponseBytes:1024}).client.readResourcePage('1','processor'),e=>{assert.doesNotMatch(e.message,/SYNTHETIC-PRIVATE|synthetic-only-token/);return e.code.startsWith('CAPACITY_');});});
test('not found and permission denied are distinct',async()=>{await assert.rejects(setup({mode:'missing'}).client.readResourcePage('1','processor'),{status:404});await assert.rejects(setup({mode:'denied'}).client.readResourcePage('1','processor'),{status:403});});
test('already cancelled means no I/O',async()=>{const{client,calls}=setup();const controller=new AbortController();controller.abort();await assert.rejects(client.readResourcePage('1','processor',{signal:controller.signal}),{code:'CAPACITY_CANCELLED'});assert.equal(calls.length,0);});
test('capacity client does not serialize its credential or expose a generic path requester',()=>{const{client}=setup();assert.doesNotMatch(JSON.stringify(client),/synthetic-only-token/);assert.equal(client.request,undefined);});
test('server URL rejects embedded credentials, unsafe protocol and nonroot path',()=>{for(const baseUrl of ['http://user:password@localhost','file:///tmp/secret','http://localhost/other?x=1'])assert.throws(()=>new LibreNmsCapacityProvider({baseUrl,token:'synthetic'}),{code:'CAPACITY_INVALID_ARGUMENT'});});
test('total deadline rejects even a fetch implementation that ignores abort',async()=>{
 const client=new LibreNmsCapacityProvider({baseUrl:'http://localhost',token:'synthetic',timeoutMs:50,fetchImpl:()=>new Promise(()=>{})});await assert.rejects(client.readResourcePage('1','processor'),{code:'CAPACITY_TIMEOUT',status:504});
});
test('stream reads and caller cancellation have the same bounded deadline',async()=>{
 let cancelled=false;const client=new LibreNmsCapacityProvider({baseUrl:'http://localhost',token:'synthetic',timeoutMs:50,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});await assert.rejects(client.readResourcePage('1','processor'),{code:'CAPACITY_TIMEOUT'});assert.equal(cancelled,true);
 const controller=new AbortController();const pending=new LibreNmsCapacityProvider({baseUrl:'http://localhost',token:'synthetic',fetchImpl:()=>new Promise(()=>{})}).readResourcePage('1','processor',{signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'CAPACITY_CANCELLED'});
});
test('per-page request count and resource identity are verified',async()=>{
 let calls=0;const client=new LibreNmsCapacityProvider({baseUrl:'http://localhost',token:'synthetic',fetchImpl:async url=>{calls++;const text=String(url);return Response.json({status:'ok',graphs:text.endsWith('/processor')?Array.from({length:25},(_,i)=>({sensor_id:i+1})):[{...raw,processor_id:text.split('/').at(-1)}]});}});const result=await client.readResourcePage('1','processor',{pageSize:20});assert.equal(result.items.length,20);assert.equal(calls,21);assert.equal(result.snapshot_consistency,'unverified');
 const bad=new LibreNmsCapacityProvider({baseUrl:'http://localhost',token:'synthetic',fetchImpl:async url=>Response.json({status:'ok',graphs:String(url).endsWith('/processor')?[{sensor_id:2}]:[{...raw,processor_id:3}]})});await assert.rejects(bad.readResourcePage('1','processor'),{code:'CAPACITY_SCOPE_MISMATCH'});
});
test('cumulative byte budget is enforced across individual valid responses',async()=>{
 let calls=0;const client=new LibreNmsCapacityProvider({baseUrl:'http://localhost',token:'synthetic',fetchImpl:async url=>{calls++;const text=String(url);return Response.json({status:'ok',padding:text.endsWith('/processor')?'':'x'.repeat(800000),graphs:text.endsWith('/processor')?[{sensor_id:1},{sensor_id:2},{sensor_id:3}]:[{...raw,processor_id:text.split('/').at(-1)}]});}});await assert.rejects(client.readResourcePage('1','processor'),{code:'CAPACITY_RESPONSE_LIMIT'});assert.equal(calls,4);
});
test('existing Insights provider exposes explicit method without constructor I/O',async()=>{
 let calls=0;const provider=new LibreNmsProvider({baseUrl:'http://localhost',token:'synthetic',fetchImpl:async()=>{calls++;return Response.json({status:'ok',graphs:[]});}});assert.equal(calls,0);const result=await provider.getDeviceCapacityPage('1','mempool');assert.equal(result.total,0);assert.equal(calls,1);
});
test('native HTTP reads all three dedicated source paths with server-only authentication',async()=>{
 let calls=0,authenticated=0;const server=createServer((req,res)=>{
   calls++;if(req.headers['x-auth-token']==='synthetic-socket-only')authenticated++;
   const match=req.url.match(/^\/api\/v0\/devices\/5\/health\/(processor|mempool|storage)(?:\/(7))?$/);
   if(!match){res.writeHead(404);res.end();return;}
   const type=match[1];const row={device_id:5,[`${type}_id`]:7};
   if(type==='processor')row.processor_usage=0;
   else Object.assign(row,{[type==='mempool'?'mempool_type':'type']:'hrstorage',[`${type}_index`]:3,[`${type}_used_oid`]:'.1.3.6.1.2.1.25.2.3.1.6.3',[type==='mempool'?'mempool_precision':'storage_units']:4096,[type==='mempool'?'mempool_total':'storage_size']:200,[`${type}_used`]:100,[`${type}_free`]:100,[`${type}_perc`]:50});
   res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',graphs:match[2]?[row]:[{sensor_id:7}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const client=new LibreNmsCapacityProvider({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-socket-only',sourceProfile:'hrstorage-normalized-v1'});
   for(const type of ['processor','mempool','storage']){const result=await client.readResourcePage('5',type);assert.equal(result.items.length,1);assert.equal(result.items[0].fields[type==='processor'?'usage_percent':'total_bytes'].value,type==='processor'?0:200);}
   assert.equal(calls,6);assert.equal(authenticated,6);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('native HTTP never follows a source redirect with the authentication header',async()=>{
 let calls=0;const server=createServer((req,res)=>{calls++;res.writeHead(302,{location:'/should-not-be-followed'});res.end();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const client=new LibreNmsCapacityProvider({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-socket-only'});await assert.rejects(client.readResourcePage('1','processor'),{code:'CAPACITY_PROVIDER_UNAVAILABLE'});assert.equal(calls,1);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
