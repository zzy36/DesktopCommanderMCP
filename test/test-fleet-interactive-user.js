import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startInteractiveUserBridge, InteractiveUserClient } from '../dist/remote-device/fleet/interactive-user-bridge.js';
const root=await mkdtemp(path.join(os.tmpdir(),'lcm-user-'));
const hostname=os.hostname().split('.')[0].toUpperCase();
let executed=0,authorized=0;
const authorizer={warmup:async()=>{},stop:async()=>{},authorize:async(projectId,host)=>{authorized++;if(projectId!=='network.local-control-mcp'||host!==hostname)throw Object.assign(new Error('denied'),{code:'PROJECT_DEVICE_DENIED'});return {projectId,deviceName:host,physicalRoot:root,partitionId:'network'}}};
const desktop={initialize:async()=>{},shutdown:async()=>{},callClientTool:async(name,args,meta)=>{executed++;assert.equal(meta.execution_context,'interactive');assert.equal(args.execution_context,undefined);if(name==='start_process'){assert.match(args.command,/FLEET_PROJECT_ID/);return {content:[{type:'text',text:'Process started with PID 5678\n中文输出'}]}}return {content:[{type:'text',text:'中文输出🙂'}]}}};
const bridge=await startInteractiveUserBridge({stateDir:path.join(root,'state'),controlRoot:root,desktop,authorizer,...(process.platform==='win32'?{}:{testSocket:path.join(root,'test.sock')})});
const client=new InteractiveUserClient(path.join(root,'state'));
const raw=async(envelope)=>{
 const manifest=JSON.parse(await readFile(bridge.manifestPath,'utf8'));
 return new Promise((resolve,reject)=>{const socket=createConnection(manifest.pipe);let chunks='';socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify(envelope)+'\n'));socket.on('data',data=>chunks+=data.toString());socket.on('end',()=>resolve(JSON.parse(JSON.parse(chunks).body)))});
};
try{
 const read=await client.callTool('read_file',{path:'fixture.txt'},'network.local-control-mcp',hostname);assert.match(JSON.stringify(read),/中文输出/);
 const start=await client.callTool('start_process',{command:'whoami',execution_context:'interactive'},'network.local-control-mcp',hostname);assert.match(JSON.stringify(start),/5678/);
 await client.callTool('read_process_output',{pid:5678},'network.local-control-mcp',hostname);
 await assert.rejects(client.callTool('read_process_output',{pid:9999},'network.local-control-mcp',hostname),/not owned/);
 await assert.rejects(client.callTool('read_file',{path:'../escape'},'network.local-control-mcp',hostname),/escapes/);
 await assert.rejects(client.callTool('read_file',{path:'fixture'},'wrong.project',hostname),/denied/);
 await assert.rejects(client.callTool('read_file',{path:'fixture'},'network.local-control-mcp','WRONGHOST'),/metadata/);
 const manifest=JSON.parse(await readFile(bridge.manifestPath,'utf8'));
 const body=JSON.stringify({id:randomUUID(),timestamp:Date.now(),projectId:'network.local-control-mcp',hostname,toolName:'read_file',args:{path:'fixture'}});
 const envelope={body,signature:createHmac('sha256',manifest.secret).update(body).digest('hex')};
 assert.equal((await raw(envelope)).ok,true);
 assert.equal((await raw(envelope)).code,'PROJECT_DEVICE_DENIED','signed request replay denied');
 assert.equal((await raw({...envelope,signature:'00'.repeat(32)})).code,'PROJECT_DEVICE_DENIED','forged request denied');
 const executions=executed;
 await writeFile(bridge.manifestPath,JSON.stringify({...manifest,updatedAt:Date.now()-300000}));
 await assert.rejects(client.callTool('read_file',{path:'fixture'},'network.local-control-mcp',hostname),/metadata/);
 assert.equal(executed,executions,'no alternate SYSTEM execution');
 assert(authorized>=executed);
 console.log('INTERACTIVE_IPC_AUTH_REPLAY_SCOPE_PROFILE_ROUTE_FAILCLOSED_PASS');
}finally{await bridge.close();await rm(root,{recursive:true,force:true})}
