#ifndef COT_VMF_WEB_SERVER_H
#define COT_VMF_WEB_SERVER_H

#include <cstddef>
#include <cstdint>

struct web_server;

/* Responses own malloc-allocated data, released by the HTTP adapter. */
struct web_response {
	int status;
	const char *content_type;
	uint8_t *data;
	size_t size;
};

/* Callbacks may execute concurrently on HTTP worker threads. All inputs
 * are borrowed for the call. Each successful activity call returns one
 * malloc-allocated JSON document and its sequence, newer than since.
 * False means no update. Caller state must survive web_server_stop.
 */
struct web_host {
	void *user;
	void (*request)(void *user, const char *method, const char *path,
			const uint8_t *body, size_t size,
			web_response *response);
	bool (*activity)(void *user, uint64_t since, uint64_t *sequence,
			 char **json, size_t *size);
};

/* Start embedded assets/API on a numeric IPv4 address and port (host:port).
 * Returns zero on success, otherwise one with a bounded diagnostic. out is
 * cleared on failure. The callback table is copied; strings are not retained.
 * Start/stop are externally serialized. Stop joins HTTP workers and frees
 * the handle. NULL stop is permitted. The web adapter owns no UDP state.
 */
int web_server_start(const char *listen, const web_host *host,
		     web_server **out, char *error, size_t error_size);
void web_server_stop(web_server *server);

#endif
