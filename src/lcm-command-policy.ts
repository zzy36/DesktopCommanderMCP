/** Set only by an LCM runtime launcher, never by a tool argument or _meta. */
export function usesCallerCommandAuthority(): boolean {
    return process.env.LCM_EXECUTOR_COMMAND_POLICY === 'caller-authorized';
}

export function commandPolicyStatus() {
    return { mode: usesCallerCommandAuthority() ? 'caller-authorized' : 'legacy-blocklist',
        legacyBlockedCommandsEnforced: !usesCallerCommandAuthority(),
        authorization: usesCallerCommandAuthority() ? 'calling surface and explicit target policy' : 'configured command blocklist',
        osPermissionsUnchanged: true };
}
