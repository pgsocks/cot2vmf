#include "service.h"
#include "workspace_cli.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>

static void usage(void)
{
	std::puts(
	    "cot-to-vmf " COT_VMF_VERSION "\n"
	    "Usage: cot-to-vmf run [options]\n"
	    "       cot-to-vmf config [--if-uninitialized] [edits]\n"
	    "       cot-to-vmf export [--active]\n"
	    "       cot-to-vmf validate [FILE]\n"
	    "All commands: --workspace DIR (or COT_VMF_WORKSPACE)\n"
	    "Run options (apply to this invocation only):\n"
	    "  --cot-listen HOST:PORT  CoT UDP input (0.0.0.0:9001)\n"
	    "  --vmf-target HOST:PORT  VMF UDP output (127.0.0.1:9002)\n"
	    "  --web [IP:PORT]     Enable GUI (0.0.0.0:8080)\n"
	    "  --no-web            Disable GUI (native default)\n"
	    "  --log-format human|json (native default: human)\n"
	    "Config edits (saved persistently):\n"
	    "  --config FILE       Replace workspace before applying edits\n"
	    "  --schema ID=FILE    Import/replace a native VMF schema\n"
	    "  --mapping ID=FILE   Import/replace an output mapping\n"
	    "  --remove-schema ID Remove schema and dependent outputs\n"
	    "  --remove-mapping ID Remove output mapping\n"
	    "  --set PATH=JSON     Edit dotted keys and zero-based indices\n"
	    "Config returns 3 when a draft is saved but remains inactive.\n"
	    "Stop the service for CLI edits; use the GUI for live edits.\n"
	    "SIGTERM/SIGINT stop; SIGHUP reloads saved active state.\n"
	    "--help | --version");
}

static int bad_arguments(void)
{
	std::fputs("Unknown, duplicate, or incomplete option\n", stderr);
	return 2;
}

static bool config_option(const char *argument)
{
	return !std::strcmp(argument, "--config") ||
	       !std::strcmp(argument, "--schema") ||
	       !std::strcmp(argument, "--mapping") ||
	       !std::strcmp(argument, "--remove-schema") ||
	       !std::strcmp(argument, "--remove-mapping") ||
	       !std::strcmp(argument, "--set");
}

static int manage(int argc, char **argv, const char *command)
{
	bool configure = !std::strcmp(command, "config");
	bool validate = !std::strcmp(command, "validate");
	bool initialize = false, active = false, imported = false;
	const char *directory = nullptr;
	const char *file = nullptr;
	const char **settings = static_cast<const char **>(
	    std::calloc(static_cast<size_t>(argc) + 1, sizeof(*settings)));

	if (!settings)
		return 1;
	int count = 0;
	int result = -1;

	for (int i = 0; i < argc; ++i) {
		if (!std::strcmp(argv[i], "--help")) {
			usage();
			result = 0;
			break;
		}
		if (!std::strcmp(argv[i], "--workspace")) {
			if (directory || ++i == argc || !*argv[i]) {
				result = bad_arguments();
				break;
			}
			directory = argv[i];
		} else if (configure &&
			   !std::strcmp(argv[i], "--if-uninitialized")) {
			if (initialize) {
				result = bad_arguments();
				break;
			}
			initialize = true;
		} else if (!configure && !validate &&
			   !std::strcmp(argv[i], "--active")) {
			if (active) {
				result = bad_arguments();
				break;
			}
			active = true;
		} else if (configure && config_option(argv[i])) {
			if (i + 1 == argc || count >= 1024 ||
			    (!std::strcmp(argv[i], "--config") && imported)) {
				result = bad_arguments();
				break;
			}
			imported |= !std::strcmp(argv[i], "--config");
			settings[count++] = argv[i];
			settings[count++] = argv[++i];
		} else if (validate && argv[i][0] != '-' && !file) {
			file = argv[i];
		} else {
			result = bad_arguments();
			break;
		}
	}
	if (result < 0) {
		if (configure)
			result = workspace_config(directory, initialize, count,
						  settings);
		else
			result = workspace_inspect(directory, file, active,
						   validate);
	}
	std::free(settings);
	return result;
}

int main(int argc, char **argv)
{
	if (argc == 2 && !std::strcmp(argv[1], "--version")) {
		std::puts("cot-to-vmf " COT_VMF_VERSION);
		return 0;
	}
	if (argc == 2 && (!std::strcmp(argv[1], "--help") ||
			  !std::strcmp(argv[1], "help"))) {
		usage();
		return 0;
	}
	if (argc > 1 && (!std::strcmp(argv[1], "config") ||
			 !std::strcmp(argv[1], "export") ||
			 !std::strcmp(argv[1], "validate")))
		return manage(argc - 2, argv + 2, argv[1]);
	service_options options = {};
	int first = argc > 1 && !std::strcmp(argv[1], "run") ? 2 : 1;
	bool web_selected = false;

	for (int i = first; i < argc; ++i) {
		if (!std::strcmp(argv[i], "--help")) {
			usage();
			return 0;
		}
		if (!std::strcmp(argv[i], "--web") ||
		    !std::strcmp(argv[i], "--no-web")) {
			if (web_selected)
				return bad_arguments();
			web_selected = true;
			if (!std::strcmp(argv[i], "--web")) {
				options.web_listen = "0.0.0.0:8080";
				if (i + 1 < argc && argv[i + 1][0] != '-')
					options.web_listen = argv[++i];
			}
			continue;
		}
		if (i + 1 == argc)
			return bad_arguments();
		const char **destination = nullptr;

		if (!std::strcmp(argv[i], "--workspace"))
			destination = &options.workspace;
		else if (!std::strcmp(argv[i], "--cot-listen"))
			destination = &options.cot_listen;
		else if (!std::strcmp(argv[i], "--vmf-target"))
			destination = &options.vmf_target;
		else if (!std::strcmp(argv[i], "--log-format"))
			destination = &options.log_format;
		if (!destination || *destination)
			return bad_arguments();
		*destination = argv[++i];
		if (destination == &options.workspace && !*options.workspace)
			return bad_arguments();
	}
	return service_run(&options);
}
