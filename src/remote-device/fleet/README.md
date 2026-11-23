# Local Control MCP device transport

Production product: 0.3.6. Owner-scoped, device-first, private-only. One ChatGPT App; Windows Agent/runtime/user executor are internal.

Public catalog: 31 tools. Discovery/status: list_devices, fleet_status, ping, who_am_i. Files: read_file, read_multiple_files, write_file, write_pdf, create_directory, list_directory, move_file, get_file_info, edit_block. Search: start_search, get_more_search_results, stop_search, list_searches. Processes: start_process, read_process_output, interact_with_process, list_sessions, force_terminate, kill_process, list_processes. Config: get_config, set_config_value. Lifecycle: shutdown (Agent only, never OS). Results/history: get_tool_result, list_remote_tool_calls, get_recent_tool_calls. Statistics: get_usage_stats.

list_devices has no arguments. Device operations require the exact enrolled hostname; execution_context defaults to interactive. get_tool_result requires call_id and can additionally assert hostname. Slow calls return running/call_id after 2.5 seconds; poll instead of repeating writes.

History responses contain call metadata and hasResult, without stored result bodies. Use get_tool_result(call_id) to fetch a selected result. Listing never alters stored records or replays a call. Existing consumers that read result from history must use the selected-result tool.

Request traces count upstream response bytes and record headers, first byte, end/abort, and downstream response completion as separate stages. These are application stream observations, not packet arrival or client-consumption acknowledgments. Trace records omit headers, credentials, parameters and body content. Compare elapsed durations within one host; absolute timestamps across hosts require an independently measured clock bound.

Upstream traces also record whether a socket was reused and a bounded transport error code. Recognized codes are ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, ENETUNREACH, EHOSTUNREACH and ERR_STREAM_PREMATURE_CLOSE; other codes become OTHER. Error messages and connection addresses are not recorded. The edge retains the existing HTTP Agent lifetime and never automatically retries a failed POST. These fields distinguish a failed upstream connection from a completed device operation without changing authentication or replay semantics.

The Gateway authenticates OAuth scopes, enrolled Ed25519 identity, hostname, connection generation and bounded transport. It does not route projects or compare governance revisions. DeviceAgent is the production service default; no .control bootstrap prerequisite. A configured external executionPolicy command receives hostname/tool/args/opaque MCP metadata on stdin and returns a JSON allow decision. Policy failure/timeout/denial blocks execution. No policy installed means Owner trust and OS permissions, not automatic business-project authorization.

The same external hook runs inside the interactive user executor. It never silently falls back to SYSTEM. Process/search follow-ups retain their creating execution context. Local admin uses a protected credential, expiring session, Origin/CSRF/rate limits; public management remains blocked.

Legacy project-scoped Agent/local stdio classes and wire compatibility are retained only for rollback/internal migration. They are not the new ChatGPT contract. Do not reinstall their visible Native plugin during device onboarding.

Retain the 16 MiB frame limit, 64 MiB completed-result cache, heartbeat/network tolerance, generation fencing, independent identities and recovery material. shutdown returns before stopping the Agent; its scheduled task can be restarted without rebooting Windows.

Windows standalone bootstrap: deploy/windows/Install-LCMAgent.ps1. Stage source/dependencies, provision an independent identity, verify hostname/code/fingerprint on the existing LAN Admin, approve into Owner, then install/start internal tasks. No L3/project/partition/plugin registration or cloned credentials.

Regression entry points: test-fleet-device-first.js, test-fleet-device-executor.js, existing test-fleet-channel.js, test-fleet-interactive-user.js, test-fleet-binding-lifecycle.js and test-fleet-enrollment.js.
