#include "web_server.h"
#include "web_assets.h"
#include <arpa/inet.h>
#include <civetweb.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <strings.h>
#include <pthread.h>
#include <time.h>

struct web_server {
	mg_context *context;
	web_host host;
	pthread_mutex_t lock;
	bool stopping;
	bool allow_dns;
	unsigned streams;
};

static const size_t maximum_body = 16 * 1024 * 1024;

static const char *reason(int status)
{
	switch (status) {
	case 200: return "OK";
	case 400: return "Bad Request";
	case 403: return "Forbidden";
	case 404: return "Not Found";
	case 405: return "Method Not Allowed";
	case 409: return "Conflict";
	case 413: return "Content Too Large";
	case 422: return "Unprocessable Content";
	case 503: return "Service Unavailable";
	default: return "Internal Server Error";
	}
}

static void headers(mg_connection *connection, int status, const char *type,
		    size_t size, bool stream)
{
	mg_printf(connection, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\n",
		  status, reason(status), type);
	if (!stream)
		mg_printf(connection, "Content-Length: %zu\r\n", size);
	mg_printf(connection,
		  "Cache-Control: no-store\r\n"
		  "X-Content-Type-Options: nosniff\r\n"
		  "Referrer-Policy: no-referrer\r\n"
		  "Content-Security-Policy: default-src 'self'; "
		  "script-src 'self'; style-src 'self'; "
		  "connect-src 'self'; object-src 'none'; "
		  "base-uri 'none'; frame-ancestors 'none'\r\n"
		  "Connection: close\r\n\r\n");
}

static int reply(mg_connection *connection, int status, const char *type,
		 const void *data, size_t size)
{
	headers(connection, status, type, size, false);
	if (size)
		mg_write(connection, data, size);
	return status;
}

static int failure(mg_connection *connection, int status, const char *text)
{
	char json[256];
	int size = std::snprintf(json, sizeof(json), "{\"error\":\"%s\"}",
				 text);

	return reply(connection, status, "application/json", json,
		     size > 0 ? static_cast<size_t>(size) : 0);
}

struct http_authority {
	char name[128];
	unsigned port;
};

static bool parse_authority(const char *text, bool allow_dns,
			    http_authority *authority)
{
	if (!text || !*text || std::strlen(text) >= sizeof(authority->name))
		return false;
	std::strcpy(authority->name, text);
	char *colon = std::strchr(authority->name, ':');

	authority->port = 80;
	if (colon) {
		*colon++ = 0;
		if (!*colon)
			return false;
		unsigned port = 0;

		for (; *colon; ++colon) {
			if (*colon < '0' || *colon > '9')
				return false;
			port = port * 10 + static_cast<unsigned>(*colon - '0');
			if (port > 65535)
				return false;
		}
		if (!port)
			return false;
		authority->port = port;
	}
	const char *name = authority->name;
	size_t label = 0;

	if (!*name)
		return false;
	for (const char *part = name; *part; ++part) {
		if (*part == '.') {
			if (!label || part[-1] == '-')
				return false;
			label = 0;
			continue;
		}
		if (!((*part >= 'a' && *part <= 'z') ||
		      (*part >= 'A' && *part <= 'Z') ||
		      (*part >= '0' && *part <= '9') ||
		      (*part == '-' && label)))
			return false;
		if (++label > 63)
			return false;
	}
	if (name[std::strlen(name) - 1] == '-')
		return false;
	in_addr address = {};

	return allow_dns || !strcasecmp(name, "localhost") ||
	       inet_pton(AF_INET, name, &address) == 1;
}

static bool same_origin(mg_connection *connection, const web_server *server)
{
	const char *host = mg_get_header(connection, "Host");
	const char *origin = mg_get_header(connection, "Origin");
	const char *site = mg_get_header(connection, "Sec-Fetch-Site");
	http_authority authority = {};

	if (!parse_authority(host, server->allow_dns, &authority))
		return false;
	if (site && std::strcmp(site, "same-origin") &&
	    std::strcmp(site, "none"))
		return false;
	if (origin) {
		http_authority source = {};

		if (strncasecmp(origin, "http://", 7) ||
		    !parse_authority(origin + 7, server->allow_dns, &source) ||
		    strcasecmp(source.name, authority.name) ||
		    source.port != authority.port)
			return false;
	}
	return true;
}

static int events(mg_connection *connection, web_server *server)
{
	pthread_mutex_lock(&server->lock);
	bool allowed = !server->stopping && server->streams < 8;

	if (allowed)
		++server->streams;
	pthread_mutex_unlock(&server->lock);
	if (!allowed)
		return failure(connection, 503, "live client limit reached");
	headers(connection, 200, "text/event-stream", 0, true);
	uint64_t since = 0;
	bool first = true;
	unsigned idle = 0;

	for (;;) {
		pthread_mutex_lock(&server->lock);
		bool stopping = server->stopping;

		pthread_mutex_unlock(&server->lock);
		if (stopping)
			break;
		uint64_t sequence = since;
		char *json = nullptr;
		size_t size = 0;
		bool changed = server->host.activity && server->host.activity(
		    server->host.user, first ? UINT64_MAX : since,
		    &sequence, &json, &size);

		if (changed && json) {
			bool sent = mg_printf(connection,
					      "id: %llu\nevent: activity\n"
					      "data: ",
					      static_cast<unsigned long long>(
						  sequence)) > 0 &&
				    mg_write(connection, json, size) > 0 &&
				    mg_write(connection, "\n\n", 2) > 0;

			std::free(json);
			if (!sent)
				break;
			since = sequence;
			first = false;
			idle = 0;
		} else {
			std::free(json);
			if (++idle >= 30) {
				if (mg_write(connection, ": keepalive\n\n",
					     13) <= 0)
					break;
				idle = 0;
			}
		}
		timespec pause = {0, 150000000};

		nanosleep(&pause, nullptr);
	}
	pthread_mutex_lock(&server->lock);
	--server->streams;
	pthread_mutex_unlock(&server->lock);
	return 200;
}

static int request(mg_connection *connection)
{
	const mg_request_info *info = mg_get_request_info(connection);
	auto *server = static_cast<web_server *>(info->user_data);
	const char *path = info->local_uri;
	bool get = !std::strcmp(info->request_method, "GET");

	if (!path || !same_origin(connection, server))
		return failure(connection, 403, "same-origin request required");
	if (get && !std::strcmp(path, "/"))
		return reply(connection, 200, "text/html; charset=utf-8",
			     web_html, sizeof(web_html) - 1);
	if (get && !std::strcmp(path, "/app.css"))
		return reply(connection, 200, "text/css; charset=utf-8",
			     web_css, sizeof(web_css) - 1);
	if (get && !std::strcmp(path, "/app.js"))
		return reply(connection, 200, "text/javascript; charset=utf-8",
			     web_js, sizeof(web_js) - 1);
	if (get && !std::strcmp(path, "/api/events"))
		return events(connection, server);
	if (std::strncmp(path, "/api/", 5) && std::strcmp(path, "/health"))
		return failure(connection, 404, "unknown route");
	if (!get && std::strcmp(info->request_method, "POST"))
		return failure(connection, 405, "method not allowed");
	if (!get && (info->content_length < 0 ||
	    static_cast<unsigned long long>(info->content_length) >
		maximum_body))
		return failure(connection, 413, "request exceeds 16 MiB");
	const char *type = mg_get_header(connection, "Content-Type");

	if (!get && (!type || std::strncmp(type, "application/json", 16) ||
		     (type[16] && type[16] != ';')))
		return failure(connection, 400, "JSON content type required");
	size_t size = get ? 0 : static_cast<size_t>(info->content_length);
	auto *body = static_cast<uint8_t *>(std::malloc(size ? size : 1));

	if (!body)
		return failure(connection, 500, "allocation failed");
	size_t used = 0;

	while (used < size) {
		int count = mg_read(connection, body + used, size - used);

		if (count <= 0) {
			std::free(body);
			return failure(connection, 400, "incomplete body");
		}
		used += static_cast<size_t>(count);
	}
	web_response response = {500, "application/json", nullptr, 0};

	server->host.request(server->host.user, info->request_method, path,
			     body, size, &response);
	std::free(body);
	int status = reply(connection, response.status,
			   response.content_type ? response.content_type
						 : "application/json",
			   response.data, response.size);

	std::free(response.data);
	return status;
}

int web_server_start(const char *listen, const web_host *host,
		     web_server **out, char *error, size_t error_size)
{
	if (out)
		*out = nullptr;
	if (!listen || !host || !host->request || !out) {
		if (error && error_size)
			std::snprintf(error, error_size,
				      "invalid HTTP server arguments");
		return 1;
	}
	auto *server = static_cast<web_server *>(
	    std::calloc(1, sizeof(web_server)));

	if (!server) {
		if (error && error_size)
			std::snprintf(error, error_size,
				      "cannot allocate HTTP server");
		return 1;
	}
	server->host = *host;
	server->allow_dns = std::strncmp(listen, "127.", 4) != 0;
	if (pthread_mutex_init(&server->lock, nullptr)) {
		if (error && error_size)
			std::snprintf(error, error_size,
				      "cannot initialize HTTP server mutex");
		std::free(server);
		return 1;
	}
	const char *options[] = {
	    "listening_ports", listen, "num_threads", "16",
	    "request_timeout_ms", "5000", "max_request_size", "16384",
	    "enable_keep_alive", "no", nullptr};
	mg_callbacks callbacks = {};

	callbacks.begin_request = request;
	mg_init_library(0);
	server->context = mg_start(&callbacks, server, options);
	if (!server->context) {
		if (error && error_size)
			std::snprintf(error, error_size,
				      "cannot start HTTP listener at %s",
				      listen);
		pthread_mutex_destroy(&server->lock);
		std::free(server);
		mg_exit_library();
		return 1;
	}
	*out = server;
	return 0;
}

void web_server_stop(web_server *server)
{
	if (!server)
		return;
	pthread_mutex_lock(&server->lock);
	server->stopping = true;
	pthread_mutex_unlock(&server->lock);
	mg_stop(server->context);
	pthread_mutex_destroy(&server->lock);
	std::free(server);
	mg_exit_library();
}
