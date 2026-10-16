import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectProbePolicy } from '../dist/remote-device/fleet/fleet-agent.js';

const root = await mkdtemp(join(tmpdir(), 'fleet-project-probe-'));
try {
  const policy = createProjectProbePolicy('.fleet-probe.txt', 32);
  const context = {
    authorization: {
      scopeKind: 'project',
      projectId: 'network.ikuai',
      partitionId: 'network',
      physicalRoot: root,
      deviceName: 'YUAN',
    },
    scopeKind: 'project',
    projectId: 'network.ikuai',
    hostname: 'YUAN',
    callId: 'test-call',
    generation: 1,
  };

  const readArgs = await policy('read_file', {}, context);
  assert.equal(readArgs.path, join(root, '.fleet-probe.txt'));

  const writeArgs = await policy('write_file', { content: 'hello', mode: 'rewrite' }, context);
  assert.equal(writeArgs.path, join(root, '.fleet-probe.txt'));
  assert.equal(writeArgs.content, 'hello');
  assert.equal(writeArgs.mode, 'rewrite');

  await assert.rejects(
    policy('write_file', { path: join(root, 'other.txt'), content: 'x' }, context),
    (error) => error?.code === 'PROJECT_DEVICE_DENIED',
  );
  await assert.rejects(
    policy('start_process', { command: 'whoami' }, context),
    (error) => error?.code === 'PROJECT_DEVICE_DENIED',
  );
  await assert.rejects(
    policy('write_file', { content: 'x'.repeat(33) }, context),
    (error) => error?.code === 'PROJECT_DEVICE_DENIED',
  );

  assert.throws(() => createProjectProbePolicy('../escape.txt'), /single file name/);
  console.log('project probe policy tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
