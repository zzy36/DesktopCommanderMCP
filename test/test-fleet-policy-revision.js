import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveControlPolicyRevision } from '../dist/remote-device/fleet/policy-revision.js';

const fixtures = resolve('../../../testing');
await mkdir(fixtures, {recursive:true});
const root = await mkdtemp(resolve(fixtures, 'policy-revision-'));
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const commit=()=>{git('add','.');git('-c','user.name=LCM Test','-c','user.email=lcm-test@localhost','commit','-qm','fixture')};
try {
 git('init','-q');
 await writeFile(resolve(root,'devices.registry.json'),'{"devices":[]}\n');commit();
 const original=await resolveControlPolicyRevision(root);
 await writeFile(resolve(root,'r0.profile.json'),'{"model":"user-selected"}\n');commit();
 assert.equal(await resolveControlPolicyRevision(root),original,'R0 commit disconnected Agent');
 await mkdir(resolve(root,'docs'));await writeFile(resolve(root,'docs/note.md'),'documentation');commit();
 assert.equal(await resolveControlPolicyRevision(root),original,'docs commit disconnected Agent');
 await writeFile(resolve(root,'devices.registry.json'),'{"devices":["HEMA"]}\n');
 await assert.rejects(resolveControlPolicyRevision(root),/uncommitted/);
 commit();assert.notEqual(await resolveControlPolicyRevision(root),original,'real authorization change must fence old session');
 await mkdir(resolve(root,'tools/machine-control'),{recursive:true});
 await writeFile(resolve(root,'tools/machine-control/policy.py'),'# untracked authorization code\n');
 await assert.rejects(resolveControlPolicyRevision(root),/uncommitted/);
 console.log('PASS: unrelated R0/docs commits stable; committed authorization changes fence; dirty/untracked policy fails closed');
} finally {
 if(!root.startsWith(fixtures+'\\')&&!root.startsWith(fixtures+'/'))throw Error('fixture cleanup escaped workspace');
 await rm(root,{recursive:true,force:true});
}
