# Sentinel agent tool protocol

Sentinel uses an OpenAI-compatible chat-completions loop. The API sends the user message, recent conversation context, and typed function definitions from `shared/src/tooling.ts`. A model turn is either:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [{
    "id": "call_123",
    "type": "function",
    "function": { "name": "system_resources", "arguments": "{}" }
  }]
}
```

After validation and execution, the runtime appends a matching tool message and asks the model for the next turn:

```json
{
  "role": "tool",
  "tool_call_id": "call_123",
  "content": "{\"ok\":true,\"tool\":\"system_resources\"}"
}
```

The loop stops at `LLM_MAX_AGENT_STEPS`. Tool names and arguments are validated with Zod twice: in the API runtime and again at the Host Agent boundary. The model never receives a shell escape hatch and never controls an executable path.

## Canonical tools

Read-only tools are `list_directory`, `search_files`, `read_file`, `git_status`, `git_diff`, `system_resources`, `listening_ports`, `systemd_status`, `journal_logs`, `docker_status`, `pm2_status`, `nginx_test`, `nginx_config_inventory`, and `hiddify_inventory`.

Modifying tools are `write_file`, `delete_file`, `delete_directory`, `restart_service`, `reload_nginx`, `remove_docker_container`, `remove_systemd_unit`, and `remove_hiddify_artifact`. Every modifying call is stopped for an expiring, single-use confirmation bound to the exact tool and arguments. The Host Agent creates a backup before file or state changes, records the operation, and returns `ok: false` when a fixed command fails.

## Hiddify cleanup

Any request containing Hiddify enters the dedicated read-only inventory workflow, regardless of mentions of Nginx, Docker, domains, VPNs, or websites. Inventory reports exact services, files, processes, containers, images, volumes, cron entries, Nginx references, and ports as definite, possible, or unrelated. It never deletes during inventory. Cleanup requires explicit YES approval for an exact inventory-confirmed artifact, runs the Nginx test before a reload, and verifies unrelated infrastructure through subsequent read-only checks.

Configure narrow deployment allowlists in `.env` (`SERVER_MANAGER_PATH_ALLOWLIST`, `GIT_REPO_ALLOWLIST`, `SYSTEMD_SERVICE_ALLOWLIST`, and the Hiddify-specific allowlists). Broad paths such as `/`, `/etc`, `/opt`, `/var`, and `/var/lib/docker` are rejected even if supplied by a model or client.

Legacy dotted tool names remain accepted only at the Host Agent/API compatibility boundary. They are not advertised to the LLM.
