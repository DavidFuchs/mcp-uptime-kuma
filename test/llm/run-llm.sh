#!/bin/bash
# LLM agent-usability eval: brings up the shared test container, runs the scenarios through
# headless Claude Code, then tears the container down. See test/llm/README.md.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../integration/infra.sh
source "$SCRIPT_DIR/../integration/infra.sh"

trap infra_down EXIT
# Exit on Ctrl+C rather than carrying on (e.g. polling for readiness); EXIT then tears down once.
trap 'exit 130' INT TERM

echo "🤖 MCP Uptime Kuma LLM Agent-Usability Eval"
echo "==========================================="
echo ""

if ! infra_up; then
    exit 1
fi

echo ""
cd "$INFRA_REPO_ROOT"
# node --import tsx rather than npx tsx: the npx and tsx wrapper processes exit on Ctrl+C
# before the runner has cleaned up, taking its output with them.
node --import tsx test/llm/run-llm.ts "$@"
exit $?
