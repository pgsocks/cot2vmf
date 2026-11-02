#!/bin/sh
set -eu

# Administrative commands and service runs share the container workspace.
COT_VMF_WORKSPACE=${COT_VMF_WORKSPACE:-/var/lib/cot-to-vmf}
export COT_VMF_WORKSPACE

if [ "$#" -eq 0 ]; then
	set -- run
fi

case "$1" in
	run) shift ;;
	--help|--version) exec cot-to-vmf "$@" ;;
	-*) ;;
	*) exec cot-to-vmf "$@" ;;
esac

# Track option arity without interpreting endpoint values. Leave malformed
# commands and help requests to the CLI before initializing any state.
run_options()
{
	entrypoint_workspace=$COT_VMF_WORKSPACE
	entrypoint_workspace_seen=0
	entrypoint_cot_seen=0
	entrypoint_vmf_seen=0
	entrypoint_web_seen=0
	entrypoint_log_seen=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--help) return 1 ;;
			--web)
				[ "$entrypoint_web_seen" -eq 0 ] || return 1
				entrypoint_web_seen=1
				shift
				if [ "$#" -gt 0 ]; then
					case "$1" in
						-*) ;;
						*) shift ;;
					esac
				fi
				;;
			--no-web)
				[ "$entrypoint_web_seen" -eq 0 ] || return 1
				entrypoint_web_seen=1
				shift
				;;
			--workspace|--cot-listen|--vmf-target|--log-format)
				[ "$#" -ge 2 ] || return 1
				case "$1" in
					--workspace)
						[ "$entrypoint_workspace_seen" -eq 0 ] || return 1
						entrypoint_workspace_seen=1
						entrypoint_workspace=$2
						;;
					--cot-listen)
						[ "$entrypoint_cot_seen" -eq 0 ] || return 1
						entrypoint_cot_seen=1
						;;
					--vmf-target)
						[ "$entrypoint_vmf_seen" -eq 0 ] || return 1
						entrypoint_vmf_seen=1
						;;
					--log-format)
						[ "$entrypoint_log_seen" -eq 0 ] || return 1
						entrypoint_log_seen=1
						;;
				esac
				shift 2
				;;
			*) return 1 ;;
		esac
	done
}

if ! run_options "$@"; then
	exec cot-to-vmf run "$@"
fi

# The native guard checks existing state before reading stale seed inputs.
# This function has separate positional arguments from the eventual run.
bootstrap()
{
	set -- config --if-uninitialized --workspace "$entrypoint_workspace"
	if [ -n "${COT_VMF_CONFIG_FILE:-}" ]; then
		set -- "$@" --config "$COT_VMF_CONFIG_FILE"
	fi
	for entrypoint_kind in schema mapping set; do
		case "$entrypoint_kind" in
			schema) entrypoint_seeds=${COT_VMF_SCHEMAS-} ;;
			mapping) entrypoint_seeds=${COT_VMF_MAPPINGS-} ;;
			set) entrypoint_seeds=${COT_VMF_SET-} ;;
		esac
		while IFS= read -r entrypoint_line; do
			[ -n "$entrypoint_line" ] || continue
			set -- "$@" "--$entrypoint_kind" "$entrypoint_line"
		done <<SEEDS
$entrypoint_seeds
SEEDS
	done
	cot-to-vmf "$@"
}

if bootstrap; then
	:
else
	entrypoint_status=$?
	# A saved invalid draft remains available for repair through the GUI.
	[ "$entrypoint_status" -eq 3 ] || exit "$entrypoint_status"
fi

# Prepend generated flags, preserving malformed trailing arguments and values.
if [ "$entrypoint_workspace_seen" -eq 0 ]; then
	set -- --workspace "$entrypoint_workspace" "$@"
fi
if [ "$entrypoint_cot_seen" -eq 0 ]; then
	set -- --cot-listen "${COT_VMF_COT_LISTEN:-0.0.0.0:9001}" "$@"
fi
if [ "$entrypoint_vmf_seen" -eq 0 ]; then
	set -- --vmf-target "${COT_VMF_VMF_TARGET:-127.0.0.1:9002}" "$@"
fi
if [ "$entrypoint_log_seen" -eq 0 ]; then
	set -- --log-format "${COT_VMF_LOG_FORMAT:-json}" "$@"
fi
if [ "$entrypoint_web_seen" -eq 0 ]; then
	entrypoint_web=${COT_VMF_WEB_LISTEN-0.0.0.0:8080}
	if [ -n "$entrypoint_web" ]; then
		set -- --web "$entrypoint_web" "$@"
	else
		set -- --no-web "$@"
	fi
fi

exec cot-to-vmf run "$@"
