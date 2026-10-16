import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FleetGateway } from '../dist/remote-device/fleet/fleet-gateway.js';
import { FleetChannel } from '../dist/remote-device/fleet/fleet-channel.js';
import { fingerprintPublicKey } from '../dist/remote-device/fleet/identity.js';
import { FleetGatewayPluginBackend } from '../dist/remote-device/fleet/gateway-plugin-backend.js';
import { createFleetPluginHttpServer } from '../dist/remote-device/fleet/plugin-server.js';
import { checkExecutionPolicy, DeviceExecutor } from '../dist/remote-device/fleet/device-executor.js';

const keys = ['YUAN','HEMA','YUANS'].map(hostname => {
    const {publicKey, privateKey} = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({type:'spki',format:'pem'}).toString();
    return { hostname, publicKeyPem, privateKey, publicKeyFingerprint: fingerprintPublicKey(publicKeyPem) };
});
const gateway = new FleetGateway({devices: keys, heartbeatTimeoutMs:90000});
const wss = new WebSocketServer({host:'127.0.0.1',port:0}); await once(wss,'listening');
wss.on('connection', socket => gateway.acceptSocket({
    get readyState(){return socket.readyState;}, send:data=>socket.send(data),close:(c,r)=>socket.close(c,r),
    onMessage:h=>socket.on('message',d=>h(d.toString())), onClose:h=>socket.on('close',h),onError:h=>socket.on('error',h),
}));
const channels = [];
const calls=[];
const backend=new FleetGatewayPluginBackend({gateway,callTimeoutMs:2000});
const http=createFleetPluginHttpServer(backend,{bearerToken:'fixture-token'});http.listen(0,'127.0.0.1');await once(http,'listening');
const client=new Client({name:'device-contract-test',version:'1'},{capabilities:{}});
const parse=r=>JSON.parse(r.content[0].text);
try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer fixture-token'}}}));
    const tools=(await client.listTools()).tools;
    assert.equal(tools.length,31);
    for(const tool of tools) {
        assert(!('project_id' in tool.inputSchema.properties));
        assert(!('scope_kind' in tool.inputSchema.properties));
        assert(!('machine_approval' in tool.inputSchema.properties));
        assert.equal(tool.icons.length,1);
    }
    for(const name of ['list_processes','set_config_value','shutdown','get_recent_tool_calls','get_usage_stats'])assert(tools.some(t=>t.name===name));
    let devices=parse(await client.callTool({name:'list_devices',arguments:{}})).devices;
    assert.equal(devices.length,3);assert(devices.every(d=>!d.online));
    for(const key of keys.slice(0,2)) {
        const channel=new FleetChannel({url:`ws://127.0.0.1:${wss.address().port}`, ...key, policyRevision:'device-v1', authorize:()=>false,authorizeDevice:h=>h===key.hostname,
            socketFactory:url=>new WebSocket(url), execute:async(name,args,ctx)=>{
                assert.equal(ctx.scopeKind,'device');assert.equal(ctx.projectId,null);
                calls.push({host:key.hostname,name,args});
                if (args.slow) await new Promise(r=>setTimeout(r,2800));
                return {content:[{type:'text',text: name==='__lcm_ping'?JSON.stringify({hostname:key.hostname}):args.large?'汉'.repeat(400000):`${key.hostname}:${name}`}]};
            }});
        channels.push(channel);channel.start();
    }
    const deadline=Date.now()+3000;while(!gateway.listKnownDeviceStatuses().slice(0,2).every(d=>d.online)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    devices=parse(await client.callTool({name:'list_devices',arguments:{}})).devices;assert.equal(devices.filter(d=>d.online).length,2);
    for(const hostname of ['YUAN','HEMA']) {
        const ping=parse(await client.callTool({name:'ping',arguments:{hostname}}));assert.equal(ping.hostname,hostname);assert(ping.round_trip_ms>=0);
        const result=await client.callTool({name:'list_processes',arguments:{hostname}});assert.equal(result.content[0].text,`${hostname}:list_processes`);
    }
    const before=calls.length;
    assert((await client.callTool({name:'ping',arguments:{hostname:'YUANS'}})).isError);
    assert((await client.callTool({name:'ping',arguments:{hostname:'IMPOSTOR'}})).isError);
    assert.equal(calls.length,before,'Offline/unknown target never redirects');
    const large=await backend.callDeviceTool('HEMA','read_file',{large:true});assert.equal(large.content[0].text.length,400000);
    const history=parse(await client.callTool({name:'list_remote_tool_calls',arguments:{}})).calls;
    assert(history.some(r=>r.hostname==='HEMA')&&history.some(r=>r.hostname==='YUAN'));
    const record=history.find(r=>r.hostname==='HEMA');assert.equal(parse(await client.callTool({name:'get_tool_result',arguments:{call_id:record.callId}})).hostname,'HEMA');
    assert((await client.callTool({name:'get_tool_result',arguments:{hostname:'YUAN',call_id:record.callId}})).isError);
    const usage=parse(await client.callTool({name:'get_usage_stats',arguments:{}}));assert(usage.calls>=history.length);assert.equal(usage.in_flight,0);assert(usage.sentBytes>0&&usage.receivedBytes>0);
    const asyncBackend=new FleetGatewayPluginBackend({gateway,callTimeoutMs:5000});
    const running=parse(await asyncBackend.callDeviceTool('HEMA','read_file',{slow:true}));assert.equal(running.status,'running');
    assert.equal((await backend.getToolResult('','HEMA',running.call_id)).status,'pending');
    await new Promise(r=>setTimeout(r,500));assert.equal((await backend.getToolResult('','HEMA',running.call_id)).status,'completed');
    const command={command:process.execPath,args:['-e',"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({allow:JSON.parse(s).tool==='read_file',reason:'external denial'})))"]};
    await checkExecutionPolicy(command,{tool:'read_file'});
    await assert.rejects(checkExecutionPolicy(command,{tool:'write_file'}),e=>e.code==='EXECUTION_POLICY_DENIED');
    await assert.rejects(checkExecutionPolicy({command:'nonexistent-lcm-policy-test',args:[]},{tool:'read_file'}),e=>e.code==='EXECUTION_POLICY_UNAVAILABLE');
    let executed=false;const executor=new DeviceExecutor({callClientTool:async()=>{executed=true;}},'HEMA',command);
    await assert.rejects(executor.execute('write_file',{}));assert.equal(executed,false);
    console.log('PASS device-first: 31 schemas, all Owner devices, exact/offline routing, real ping, large result, Owner history, counters, external policy fail-closed');
} finally {
    await client.close();for(const channel of channels)await channel.stop();await gateway.stop();await new Promise(r=>wss.close(r));await new Promise(r=>http.close(r));
}
