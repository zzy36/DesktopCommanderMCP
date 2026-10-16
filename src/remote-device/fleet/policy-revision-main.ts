import { resolveControlPolicyRevision } from './policy-revision.js';
const root = process.argv[2];
if (!root) throw new Error('usage: policy-revision-main <control-root>');
process.stdout.write(`${await resolveControlPolicyRevision(root)}\n`);
