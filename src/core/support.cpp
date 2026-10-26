#include "bridge.h"
#include <cstdarg>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

struct alignas(std::max_align_t) block {
	block *next;
};

void *bridge_alloc(bridge_context *ctx, size_t size)
{
	const size_t limit = 64 * 1024 * 1024;

	if (!size)
		size = 1;
	if (size > limit - sizeof(block) ||
	    size + sizeof(block) > limit - ctx->arena.used) {
		bridge_fail(ctx, "tool allocation budget exhausted");
		return nullptr;
	}
	void *memory = std::malloc(sizeof(block) + size);

	if (!memory) {
		bridge_fail(ctx, "tool allocation failed");
		return nullptr;
	}
	auto *entry =
	    new (memory) block{static_cast<block *>(ctx->arena.blocks)};

	ctx->arena.blocks = entry;
	ctx->arena.used += sizeof(block) + size;
	std::memset(entry + 1, 0, size);
	return entry + 1;
}

void bridge_arena_destroy(bridge_arena *arena)
{
	auto *entry = static_cast<block *>(arena->blocks);

	while (entry) {
		block *next = entry->next;

		std::free(entry);
		entry = next;
	}
	*arena = {};
}

bool bridge_fail(bridge_context *ctx, const char *format, ...)
{
	va_list args;

	va_start(args, format);
	std::vsnprintf(ctx->error, sizeof(ctx->error), format, args);
	va_end(args);
	return false;
}

static void notice(bridge_context *ctx, const char *code, bool warning,
		   const char *format, va_list args)
{
	auto *entry = static_cast<bridge_notice *>(
	    bridge_alloc(ctx, sizeof(bridge_notice)));

	if (!entry)
		return;
	entry->code = code;
	entry->warning = warning;
	entry->cot_id = ctx->current_cot;
	entry->index = ctx->current_index;
	entry->selector = ctx->current_selector;
	std::memcpy(entry->config_path, ctx->config_path,
		    sizeof(entry->config_path));
	std::vsnprintf(entry->message, sizeof(entry->message), format, args);
	if (ctx->last_notice)
		ctx->last_notice->next = entry;
	else
		ctx->first_notice = entry;
	ctx->last_notice = entry;
	ctx->warnings += warning;
}

void bridge_warn(bridge_context *ctx, const char *format, ...)
{
	va_list args;

	va_start(args, format);
	notice(ctx, "quantization", true, format, args);
	va_end(args);
}

void bridge_note(bridge_context *ctx, const char *code, bool warning,
		 const char *format, ...)
{
	va_list args;

	va_start(args, format);
	notice(ctx, code, warning, format, args);
	va_end(args);
}

void bridge_location(bridge_context *ctx, const char *path, int cot_id,
		     const vmf_index_schema *index,
		     const bridge_selector *selector)
{
	std::snprintf(ctx->config_path, sizeof(ctx->config_path), "%s",
		      path ? path : "");
	ctx->current_cot = cot_id;
	ctx->current_index = index;
	ctx->current_selector = selector ? *selector : bridge_selector{};
}

bool bridge_selector_equal(const bridge_selector *a, const bridge_selector *b)
{
	if (a->count != b->count)
		return false;
	for (size_t i = 0; i < a->count; ++i)
		if (a->items[i].id != b->items[i].id ||
		    a->items[i].occurrence != b->items[i].occurrence)
			return false;
	return true;
}

vmf_author_address bridge_address(bridge_context *ctx,
				  const vmf_index_schema *index,
				  vmf_scope_ref scope,
				  const bridge_selector *selector)
{
	return {0,
		ctx->message,
		index,
		scope,
		selector->count ? selector->items : nullptr,
		selector->count};
}

vmf_header_fields *bridge_header_fields(bridge_context *ctx)
{
	switch (ctx->schemas->envelope) {
	case VMF_ENVELOPE_B:
		return &ctx->header.b.fields;
	case VMF_ENVELOPE_C:
		return &ctx->header.c.fields;
	case VMF_ENVELOPE_D:
		return &ctx->header.d.fields;
	case VMF_ENVELOPE_D1:
		return &ctx->header.d1.fields;
	}
	return nullptr;
}
