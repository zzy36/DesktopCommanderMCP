# LCM command authority

The Owner requested a general remote execution channel broader than RDC, including sudo, service/network administration, reboot and shutdown. A command name is not a second approval authority.

LCM DeviceAgent, device-first Interactive User Bridge and LCM local stdio launch their executor child with `LCM_EXECUTOR_COMMAND_POLICY=caller-authorized`. The executor forwards commands unchanged after schema checks. It does not enforce the inherited DesktopCommander keyword list. Tool arguments and metadata cannot change this process-level mode.

The calling assistant remains responsible for the actual task authorization and any required user approval. The transport retains enrolled-device identity, exact-host routing, signed sessions, OAuth/Owner binding and OS permissions. Explicitly installed external target policy is retained; its rejection must be reported at that layer. A request being transported does not authorize every possible operation.

No shared RDC config or saved `blockedCommands` array is erased. Generic DesktopCommander use keeps its legacy mode; effective LCM mode is reported separately by get_config and fixed management diagnostics. This prevents policy changes from silently affecting RDC.

Gateway administration may deploy only a locally staged, commit-pinned command-policy package through the authenticated, Origin/CSRF-protected maintenance route. The request accepts only an exact hostname. The package cannot be supplied by the caller. Deployment verifies known module hashes, preserves config/identity/task principals, stages dependencies, imports modules before switching and rolls back a failed start. The separate update task is deferred so it can return before restarting LCM, and removes itself on success. Unknown outcomes must be read back, never automatically replayed.

Tests for sudo/reboot/shutdown and related commands use a stubbed terminal boundary. They must never actually reboot, shut down or elevate a target as part of policy acceptance.
