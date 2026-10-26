#ifndef COT_VMF_SERVICE_H
#define COT_VMF_SERVICE_H

struct service_options {
	const char *config;
	const char *workspace;
	const char *cot_listen;
	const char *vmf_target;
	const char *web_listen;
	const char *log_format;
};

/* Foreground service. Configuration errors return 2, I/O errors 1;
 * orderly SIGINT/SIGTERM returns 0. All strings are borrowed until return.
 */
int service_run(const service_options *options);
int service_validate(const char *path);

#endif
