import assert from 'node:assert/strict';import {createServer,request} from 'node:http';
import {closeFleetHttpServer} from '../dist/remote-device/fleet/gateway-service.js';
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: held\n\n');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const req=request(`http://127.0.0.1:${server.address().port}`);req.on('error',()=>{});
const ready=new Promise(r=>req.on('response',res=>{res.on('error',()=>{});res.once('data',r);}));req.end();await ready;
const start=Date.now();await closeFleetHttpServer(server,50);assert(Date.now()-start<1000);req.destroy();
console.log('PASS gateway shutdown closes an active held HTTP stream without waiting for systemd kill');
