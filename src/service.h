#ifndef COT_VMF_SERVICE_H
#define COT_VMF_SERVICE_H

struct service_options {
	const char *workspace;
	const char *cot_listen;
	const char *vmf_target;
	/* Multicast-only sender settings, validated for every destination.
	 * NULL interface or 0.0.0.0 uses system routing; otherwise use a
	 * numeric local IPv4 address. NULL TTL defaults to 1; decimal 0..255
	 * is accepted. NULL loop defaults to 1; only "0" or "1" is accepted.
	 */
	const char *vmf_multicast_interface;
	const char *vmf_multicast_ttl;
	const char *vmf_multicast_loop;
	const char *web_listen;
	const char *log_format;
};

/* Foreground service. Configuration errors return 2, I/O errors 1;
 * orderly SIGINT/SIGTERM returns 0. All strings are borrowed until return.
 */
int service_run(const service_options *options);

#endif
