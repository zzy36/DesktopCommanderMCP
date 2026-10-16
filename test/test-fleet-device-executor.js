import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { startInteractiveUserBridge, InteractiveUserClient } from '../dist/remote-device/fleet/interactive-user-bridge.js';
import { loadAgentServiceConfig, loadGatewayServiceConfig } from '../dist/remote-device/fleet/service-config.js';
const root=await mkdtemp(path.join(os.tmpdir(),'lcm-device-executor-'));
let bridge;
try {
    const host=os.hostname().toUpperCase(); let executed=0;let legacyCalls=0;
    const authorizer={warmup:async()=>{legacyCalls++;},stop:async()=>{},authorize:async()=>{throw Error('legacy');},authorizeMachine:async()=>{throw Error('legacy');}};
    bridge=await startInteractiveUserBridge({controlRoot:'',stateDir:root,deviceFirst:true,authorizer,
        ...(process.platform==='win32'?{}:{testSocket:path.join(root,'user.sock')}),
        executionPolicy:{command:process.execPath,args:['-e',"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({allow:JSON.parse(s).tool==='get_config'})))"]},
        desktop:{initialize:async()=>{},shutdown:async()=>{},callClientTool:async(name,args)=>{executed++;return {content:[{type:'text',text:JSON.stringify({name,args,host})}]};}},
    });
    const client=new InteractiveUserClient(root);
    const result=await client.callTool('get_config',{},null,host,undefined,'device');assert.equal(JSON.parse(result.content[0].text).host,host);assert.equal(legacyCalls,0);
    await assert.rejects(client.callTool('write_file',{path:'anywhere',content:'denied'},null,host,undefined,'device'),e=>e.code==='EXECUTION_POLICY_DENIED');assert.equal(executed,1);
    await assert.rejects(client.callTool('get_config',{},null,'IMPOSTOR',undefined,'device'));
    const agentFile=path.join(root,'agent.json');await writeFile(agentFile,JSON.stringify({schemaVersion:1,gatewayUrl:'wss://localhost/agent',hostname:host,stateDir:root}));
    const config=await loadAgentServiceConfig(agentFile,{});assert.equal(config.controlRoot,'');assert.equal(config.deviceFirst,true);
    const gatewayFile=path.join(root,'gateway.json');await writeFile(gatewayFile,JSON.stringify({schemaVersion:1,mcp:{listenPort:0,auth:{type:'bearer'}},agent:{listenPort:0},stateDir:root,devices:[]}));
    const gateway=await loadGatewayServiceConfig(gatewayFile,{});assert.equal(gateway.projects.length,0);assert.equal(gateway.devices.length,0);
    console.log('PASS device executor: real authenticated user IPC, no governance bootstrap prerequisite, external denial, wrong-host rejection');
} finally {await bridge?.close();await rm(root,{recursive:true,force:true});}
