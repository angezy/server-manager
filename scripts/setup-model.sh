#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${1:-.env}"
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
LLM_PROVIDER=""; LLM_BASE_URL=""; LLM_MODEL=""; LLM_API_KEY=""; LLM_TIMEOUT_MS="60000"
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  case "$key" in
    LLM_PROVIDER) LLM_PROVIDER="$value";;
    LLM_BASE_URL) LLM_BASE_URL="$value";;
    LLM_MODEL) LLM_MODEL="$value";;
    LLM_API_KEY) LLM_API_KEY="$value";;
    LLM_TIMEOUT_MS) LLM_TIMEOUT_MS="$value";;
  esac
done < "$ENV_FILE"
: "${LLM_PROVIDER:?LLM_PROVIDER is required}"
: "${LLM_BASE_URL:?LLM_BASE_URL is required}"
: "${LLM_MODEL:?LLM_MODEL is required}"
: "${LLM_API_KEY:?LLM_API_KEY is required}"
[[ "${#LLM_API_KEY}" -ge 8 ]] || { echo "LLM_API_KEY is too short." >&2; exit 1; }
[[ "$LLM_BASE_URL" =~ ^https:// ]] || { echo "LLM_BASE_URL must use HTTPS." >&2; exit 1; }
[[ "$LLM_API_KEY" != *$'\n'* ]] || { echo "LLM_API_KEY contains a newline." >&2; exit 1; }
MASKED="${LLM_API_KEY:0:4}…${LLM_API_KEY: -4}"
echo "Provider: $LLM_PROVIDER"
echo "Base URL: $LLM_BASE_URL"
echo "Model: $LLM_MODEL"
echo "API key: $MASKED"
AUTH_HEADER="Authorization: Bearer $LLM_API_KEY"
BASE="${LLM_BASE_URL%/}"
curl --fail-with-body --silent --show-error --max-time 20 -H "$AUTH_HEADER" "$BASE/models" >/dev/null || { echo "Provider/model availability check failed." >&2; exit 1; }
PAYLOAD="{\"model\":\"$LLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Return JSON with ok=true.\"}],\"max_tokens\":32,\"response_format\":{\"type\":\"json_object\"}}"
curl --fail-with-body --silent --show-error --max-time "${LLM_TIMEOUT_MS:-60000}" -H "$AUTH_HEADER" -H 'Content-Type: application/json' -d "$PAYLOAD" "$BASE/chat/completions" >/dev/null || { echo "Basic structured completion failed." >&2; exit 1; }
TOOL_PAYLOAD="{\"model\":\"$LLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Use the test tool.\"}],\"max_tokens\":32,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"sentinel_test\",\"description\":\"test\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}]}"
curl --fail-with-body --silent --show-error --max-time 20 -H "$AUTH_HEADER" -H 'Content-Type: application/json' -d "$TOOL_PAYLOAD" "$BASE/chat/completions" >/dev/null || { echo "Tool-call formatting test failed." >&2; exit 1; }
STREAM_PAYLOAD="{\"model\":\"$LLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say ready.\"}],\"max_tokens\":8,\"stream\":true}"
curl --fail-with-body --silent --show-error --max-time 20 -N -H "$AUTH_HEADER" -H 'Content-Type: application/json' -d "$STREAM_PAYLOAD" "$BASE/chat/completions" >/dev/null || { echo "Streaming test failed." >&2; exit 1; }
echo "Remote LLM validation passed. No local model was installed or started."
