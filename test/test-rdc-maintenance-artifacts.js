import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createAgentHttpServer} from '../dist/remote-device/fleet/gateway-service.js';
const temp=await mkdtemp(path.join(os.tmpdir(),'rdc-artifacts-'));
const artifact=path.join(temp,'runtime.zip');await writeFile(artifact,'PUBLIC_TEST_ARTIFACT');
const server=createAgentHttpServer({}, {LCM_RDC_RUNTIME_ARCHIVE:artifact});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const r=await fetch(base+'/artifacts/rdc-0.3.3.zip');assert.equal(r.status,200);assert.equal(await r.text(),'PUBLIC_TEST_ARTIFACT');
 assert.equal((await fetch(base+'/artifacts/other.zip')).status,404);
 assert.equal((await fetch(base+'/artifacts/../gateway.env')).status,404);
 assert.equal((await fetch(base+'/artifacts/rdc-0.3.3.zip',{method:'POST'})).status,404);
 assert.equal((await fetch(base+'/healthz')).status,200);
 console.log('PASS fixed public runtime artifact, traversal rejection, read-only route, existing health');
}finally{await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
