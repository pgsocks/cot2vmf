#include "service.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>

static void usage(void)
{
	std::puts(
	    "cot-to-vmf " COT_VMF_VERSION "\n"
	    "Usage: cot-to-vmf run [options]\n"
	    "       cot-to-vmf validate FILE\n"
	    "Options:\n"
	    "  --config FILE       Initial cot-vmf-workspace/1 configuration\n"
	    "  --workspace DIR     Persistent drafts and active configuration\n"
	    "  --cot-listen HOST:PORT  Gateway XML UDP input (0.0.0.0:9001)\n"
	    "  --vmf-target HOST:PORT  VMF UDP destination (127.0.0.1:9002)\n"
	    "  --web HOST:PORT     Enable GUI (normally 127.0.0.1:8080)\n"
	    "  --log-format human|json\n"
	    "  --help | --version\n"
	    "Without schemas or mappings the service reports reception only.\n"
	    "SIGTERM/SIGINT stop; SIGHUP reloads the configured file.\n"
	    "Transport settings in a configuration require service restart.");
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
	if (argc >= 2 && !std::strcmp(argv[1], "validate")) {
		if (argc == 3)
			return service_validate(argv[2]);
		usage();
		return 2;
	}
	service_options options = {};
	int first = argc > 1 && !std::strcmp(argv[1], "run") ? 2 : 1;

	for (int i = first; i < argc; ++i) {
		if (!std::strcmp(argv[i], "--help")) {
			usage();
			return 0;
		}
		if (i + 1 == argc) {
			std::fputs("Expected option and value\n", stderr);
			return 2;
		}
		const char **destination = nullptr;

		if (!std::strcmp(argv[i], "--config"))
			destination = &options.config;
		else if (!std::strcmp(argv[i], "--workspace"))
			destination = &options.workspace;
		else if (!std::strcmp(argv[i], "--cot-listen"))
			destination = &options.cot_listen;
		else if (!std::strcmp(argv[i], "--vmf-target"))
			destination = &options.vmf_target;
		else if (!std::strcmp(argv[i], "--web"))
			destination = &options.web_listen;
		else if (!std::strcmp(argv[i], "--log-format"))
			destination = &options.log_format;
		if (!destination || *destination) {
			std::fputs("Unknown or duplicate option\n", stderr);
			return 2;
		}
		*destination = argv[++i];
	}
	return service_run(&options);
}
