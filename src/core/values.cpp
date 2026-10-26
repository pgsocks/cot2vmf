#include "bridge.h"
#include <cfloat>
#include <cmath>
#include <cstring>

/* Keep JSON integer domains exact. Tables map logical CoT values directly to
 * raw VMF codes, ahead of engineering conversions. Numeric conversion then
 * applies schema sign/scale and mapping factor/offset with checked rounding.
 * Text and binary fields retain caller-owned storage or use the context arena.
 */

bool bridge_json_value(bridge_context *ctx, yyjson_val *json,
		       bridge_value *value)
{
	*value = {};
	if (yyjson_is_bool(json)) {
		value->kind = BRIDGE_BOOL;
		value->boolean = yyjson_get_bool(json);
	} else if (yyjson_is_uint(json)) {
		value->kind = BRIDGE_UINT;
		value->u = yyjson_get_uint(json);
	} else if (yyjson_is_sint(json)) {
		value->kind = BRIDGE_INT;
		value->i = yyjson_get_sint(json);
	} else if (yyjson_is_real(json)) {
		value->kind = BRIDGE_REAL;
		value->real = yyjson_get_real(json);
		if (!std::isfinite(value->real))
			return bridge_fail(ctx, "JSON number must be finite");
	} else if (yyjson_is_str(json)) {
		value->kind = BRIDGE_TEXT;
		value->text = yyjson_get_str(json);
		value->size = yyjson_get_len(json);
	} else {
		return bridge_fail(ctx, "expected a scalar JSON value");
	}
	return true;
}

int bridge_lookup_compare(const bridge_value *a, const bridge_value *b)
{
	if (a->kind != b->kind)
		return a->kind < b->kind ? -1 : 1;
	if (a->kind == BRIDGE_UINT)
		return (a->u > b->u) - (a->u < b->u);
	if (a->kind == BRIDGE_REAL)
		return (a->real > b->real) - (a->real < b->real);
	size_t common = a->size < b->size ? a->size : b->size;
	int order = common ? std::memcmp(a->text, b->text, common) : 0;

	return order ? order : (a->size > b->size) - (a->size < b->size);
}

namespace
{

/* Three binary64 inputs and two schema rationals need at most 3304 bits. */
/* This covers ((source - offset) / factor - bias) / scale unreduced. */
/* Extra space covers the 64-bit quotient bound and remainder doubling. */
static_assert(FLT_RADIX == 2 && DBL_MANT_DIG <= 53 && DBL_MAX_EXP <= 1024 &&
	      DBL_MIN_EXP >= -1021, "numeric conversion requires binary64");

struct natural {
	uint32_t words[128];
	size_t count;
};

struct fraction {
	natural numerator;
	natural denominator;
	bool negative;
};

static void trim(natural *value)
{
	while (value->count && !value->words[value->count - 1])
		--value->count;
}

static void natural_value(uint64_t value, natural *result)
{
	*result = {};
	result->words[0] = static_cast<uint32_t>(value);
	result->words[1] = static_cast<uint32_t>(value >> 32);
	result->count = result->words[1] ? 2 : value != 0;
}

static int compare(const natural *a, const natural *b)
{
	if (a->count != b->count)
		return a->count > b->count ? 1 : -1;
	for (size_t i = a->count; i; --i)
		if (a->words[i - 1] != b->words[i - 1])
			return a->words[i - 1] > b->words[i - 1] ? 1 : -1;
	return 0;
}

static bool add(const natural *a, const natural *b, natural *result)
{
	*result = {};
	result->count = a->count > b->count ? a->count : b->count;
	uint64_t carry = 0;

	for (size_t i = 0; i < result->count; ++i) {
		uint64_t sum = carry + (i < a->count ? a->words[i] : 0);

		sum += i < b->count ? b->words[i] : 0;
		result->words[i] = static_cast<uint32_t>(sum);
		carry = sum >> 32;
	}
	if (carry) {
		if (result->count == 128)
			return false;
		result->words[result->count++] = static_cast<uint32_t>(carry);
	}
	return true;
}

/* a >= b; result may alias a for the bounded division below. */
static void subtract(const natural *a, const natural *b, natural *result)
{
	uint64_t borrow = 0;

	for (size_t i = 0; i < a->count; ++i) {
		uint64_t sub = borrow + (i < b->count ? b->words[i] : 0);
		uint64_t word = a->words[i];

		result->words[i] = static_cast<uint32_t>(word - sub);
		borrow = word < sub;
	}
	result->count = a->count;
	trim(result);
}

static bool multiply(const natural *a, const natural *b, natural *result)
{
	*result = {};
	if (!a->count || !b->count)
		return true;
	if (a->count + b->count > 128)
		return false;
	result->count = a->count + b->count;
	for (size_t i = 0; i < a->count; ++i) {
		uint64_t carry = 0;

		for (size_t j = 0; j < b->count; ++j) {
			uint64_t product = uint64_t(a->words[i]) * b->words[j] +
					   result->words[i + j] + carry;

			result->words[i + j] = static_cast<uint32_t>(product);
			carry = product >> 32;
		}
		result->words[i + b->count] = static_cast<uint32_t>(carry);
	}
	trim(result);
	return true;
}

static bool shift(const natural *value, unsigned bits, natural *result)
{
	*result = {};
	if (!value->count)
		return true;
	unsigned whole = bits / 32, partial = bits % 32;

	if (value->count + whole + (partial != 0) > 128)
		return false;
	result->count = value->count + whole + (partial != 0);
	for (size_t i = 0; i < value->count; ++i) {
		uint64_t word = uint64_t(value->words[i]) << partial;

		result->words[i + whole] |= static_cast<uint32_t>(word);
		if (partial)
			result->words[i + whole + 1] =
			    static_cast<uint32_t>(word >> 32);
	}
	trim(result);
	return true;
}

static uint64_t magnitude(int64_t value)
{
	return value < 0 ? static_cast<uint64_t>(-(value + 1)) + 1
			 : static_cast<uint64_t>(value);
}

static bool fraction_value(const bridge_value *value, fraction *result)
{
	*result = {};
	natural_value(1, &result->denominator);
	if (value->kind == BRIDGE_UINT) {
		natural_value(value->u, &result->numerator);
		return true;
	}
	if (value->kind == BRIDGE_INT) {
		result->negative = value->i < 0;
		natural_value(magnitude(value->i), &result->numerator);
		return true;
	}
	if (value->kind != BRIDGE_REAL || !std::isfinite(value->real))
		return false;
	if (!value->real)
		return true;
	int exponent;
	double mantissa = std::frexp(std::fabs(value->real), &exponent);
	uint64_t significand =
	    static_cast<uint64_t>(std::ldexp(mantissa, DBL_MANT_DIG));

	result->negative = value->real < 0;
	exponent -= DBL_MANT_DIG;
	while (!(significand & 1)) {
		significand >>= 1;
		++exponent;
	}
	natural_value(significand, &result->numerator);
	natural shifted = {};

	if (!shift(exponent < 0 ? &result->denominator : &result->numerator,
		   static_cast<unsigned>(exponent < 0 ? -exponent : exponent),
		   &shifted))
		return false;
	if (exponent < 0)
		result->denominator = shifted;
	else
		result->numerator = shifted;
	return true;
}

static fraction schema_fraction(vmf_rational value)
{
	fraction result = {};

	result.negative = value.numerator < 0;
	natural_value(magnitude(value.numerator), &result.numerator);
	natural_value(value.denominator, &result.denominator);
	return result;
}

static bool difference(const fraction *a, const fraction *b, fraction *result)
{
	natural left = {}, right = {};
	fraction out = {};

	if (!multiply(&a->numerator, &b->denominator, &left) ||
	    !multiply(&b->numerator, &a->denominator, &right) ||
	    !multiply(&a->denominator, &b->denominator, &out.denominator))
		return false;
	if (a->negative != b->negative) {
		if (!add(&left, &right, &out.numerator))
			return false;
		out.negative = a->negative;
	} else if (compare(&left, &right) >= 0) {
		subtract(&left, &right, &out.numerator);
		out.negative = a->negative;
	} else {
		subtract(&right, &left, &out.numerator);
		out.negative = !a->negative;
	}
	*result = out;
	return true;
}

static bool divide(const fraction *a, const fraction *b, fraction *result)
{
	fraction out = {};

	if (!b->numerator.count ||
	    !multiply(&a->numerator, &b->denominator, &out.numerator) ||
	    !multiply(&a->denominator, &b->numerator, &out.denominator))
		return false;
	out.negative = a->negative != b->negative;
	*result = out;
	return true;
}

static bool real_integer_equal(double real, const bridge_value *integer)
{
	if (!std::isfinite(real) || std::trunc(real) != real)
		return false;
	if (integer->kind == BRIDGE_UINT)
		return real >= 0 && real < std::ldexp(1.0, 64) &&
		       static_cast<uint64_t>(real) == integer->u;
	if (integer->kind == BRIDGE_INT)
		return real >= -std::ldexp(1.0, 63) &&
		       real < std::ldexp(1.0, 63) &&
		       static_cast<int64_t>(real) == integer->i;
	return false;
}

static bool equal(const bridge_value *a, const bridge_value *b)
{
	if (a->kind == BRIDGE_TEXT && b->kind == BRIDGE_TEXT)
		return a->size == b->size &&
		       (!a->size || !std::memcmp(a->text, b->text, a->size));
	if (a->kind == BRIDGE_BOOL && b->kind == BRIDGE_BOOL)
		return a->boolean == b->boolean;
	if (a->kind == BRIDGE_UINT && b->kind == BRIDGE_UINT)
		return a->u == b->u;
	if (a->kind == BRIDGE_INT && b->kind == BRIDGE_INT)
		return a->i == b->i;
	if (a->kind == BRIDGE_UINT && b->kind == BRIDGE_INT)
		return b->i >= 0 && a->u == static_cast<uint64_t>(b->i);
	if (a->kind == BRIDGE_INT && b->kind == BRIDGE_UINT)
		return a->i >= 0 && static_cast<uint64_t>(a->i) == b->u;
	if (a->kind == BRIDGE_REAL && b->kind == BRIDGE_REAL)
		return a->real == b->real;
	if (a->kind == BRIDGE_REAL)
		return real_integer_equal(a->real, b);
	if (b->kind == BRIDGE_REAL)
		return real_integer_equal(b->real, a);
	return false;
}

static bool transform(bridge_context *ctx, const bridge_binding *binding,
			      fraction *factor, fraction *offset)
{
	bridge_value value = {};

	value.kind = BRIDGE_UINT;
	value.u = 1;
	fraction_value(&value, factor);
	value.u = 0;
	fraction_value(&value, offset);
	yyjson_val *json = yyjson_obj_get(binding->options, "factor");

	if (json &&
	    (!bridge_json_value(ctx, json, &value) ||
	     !fraction_value(&value, factor)))
		return bridge_fail(ctx, "factor requires a finite number");
	json = yyjson_obj_get(binding->options, "offset");
	if (json &&
	    (!bridge_json_value(ctx, json, &value) ||
	     !fraction_value(&value, offset)))
		return bridge_fail(ctx, "offset requires a finite number");
	return factor->numerator.count ||
	       bridge_fail(ctx, "factor must be nonzero");
}

static bool table_lookup(const bridge_binding *binding,
			 const bridge_value *value, uint64_t *code)
{
	if (value->kind == BRIDGE_REAL && !std::isfinite(value->real))
		return false;
	size_t begin = 0, end = binding->lookup_count;

	while (begin < end) {
		size_t middle = begin + (end - begin) / 2;
		const bridge_lookup_entry *entry = &binding->lookup[middle];
		int order = bridge_lookup_compare(value, &entry->key);

		if (order < 0)
			end = middle;
		else if (order > 0)
			begin = middle + 1;
		else {
			*code = entry->code;
			return true;
		}
	}
	return false;
}

static uint64_t mask(const vmf_index_info *definition)
{
	unsigned width = definition->integer.bit_width;

	return width == 64 ? UINT64_MAX : (UINT64_C(1) << width) - 1;
}

static bool signed_code(bridge_context *ctx, const vmf_index_info *definition,
			int64_t value, uint64_t *code)
{
	unsigned width = definition->integer.bit_width;
	uint64_t sign = UINT64_C(1) << (width - 1);
	uint64_t magnitude = value < 0 ? static_cast<uint64_t>(-(value + 1)) + 1
				       : static_cast<uint64_t>(value);
	vmf_integer_representation rep = definition->integer.representation;
	bool twos = rep == VMF_INTEGER_TWOS_COMPLEMENT;

	if ((value >= 0 && magnitude >= sign) ||
	    (value < 0 && magnitude > sign - !twos))
		return bridge_fail(ctx, "signed VMF value is out of range");
	if (value >= 0)
		*code = magnitude;
	else if (twos)
		*code = UINT64_C(0) - magnitude;
	else if (rep == VMF_INTEGER_ONES_COMPLEMENT)
		*code = ~magnitude;
	else
		*code = sign | magnitude;
	*code &= mask(definition);
	return true;
}

static bool signed_value(bridge_context *ctx, const vmf_index_info *definition,
			 uint64_t code, int64_t *value,
			 bool allow_negative_zero)
{
	uint64_t sign = UINT64_C(1) << (definition->integer.bit_width - 1);
	vmf_integer_representation rep = definition->integer.representation;

	if (!(code & sign)) {
		*value = static_cast<int64_t>(code);
		return true;
	}
	uint64_t magnitude;

	if (rep == VMF_INTEGER_TWOS_COMPLEMENT)
		magnitude = (~code & mask(definition)) + 1;
	else if (rep == VMF_INTEGER_ONES_COMPLEMENT)
		magnitude = ~code & mask(definition);
	else
		magnitude = code & ~sign;
	if (!magnitude && !allow_negative_zero)
		return bridge_fail(ctx, "negative zero is invalid for SIGNED");
	if (!magnitude && allow_negative_zero)
		bridge_warn(ctx, "scaled negative zero becomes numeric zero; "
				 "use a values table to preserve its raw code");
	*value = magnitude == (UINT64_C(1) << 63)
		     ? INT64_MIN
		     : -static_cast<int64_t>(magnitude);
	return true;
}

static bool sentinel(const vmf_index_info *definition, uint64_t code)
{
	for (size_t i = 0; i < definition->scale->sentinel_count; ++i) {
		if (definition->scale->sentinels[i] == code)
			return true;
	}
	return false;
}

static bool integer(bridge_context *ctx, const fraction *value, bool is_signed,
		    uint64_t *u, int64_t *i)
{
	natural remainder = value->numerator, shifted = {};

	if (!shift(&value->denominator, 64, &shifted))
		return bridge_fail(ctx, "numeric precision exhausted");
	if (compare(&remainder, &shifted) >= 0)
		return bridge_fail(ctx, "numeric conversion overflows integer");
	uint64_t rounded = 0;

	for (int bit = 63; bit >= 0; --bit) {
		if (!shift(&value->denominator, static_cast<unsigned>(bit),
			   &shifted))
			return bridge_fail(ctx,
					   "numeric precision exhausted");
		if (compare(&remainder, &shifted) >= 0) {
			subtract(&remainder, &shifted, &remainder);
			rounded |= UINT64_C(1) << bit;
		}
	}
	if (!shift(&remainder, 1, &shifted))
		return bridge_fail(ctx, "numeric precision exhausted");
	if (compare(&shifted, &value->denominator) >= 0) {
		if (rounded == UINT64_MAX)
			return bridge_fail(
			    ctx, "numeric conversion overflows integer");
		++rounded;
	}
	uint64_t limit = UINT64_C(1) << 63;

	if ((is_signed && rounded > limit - !value->negative) ||
	    (!is_signed && value->negative && rounded))
		return bridge_fail(ctx, "numeric conversion overflows integer");
	if (remainder.count)
		bridge_warn(ctx, "fractional raw value rounded");
	if (is_signed)
		*i = value->negative
			 ? (rounded == limit ? INT64_MIN
					     : -static_cast<int64_t>(rounded))
			 : static_cast<int64_t>(rounded);
	else
		*u = rounded;
	return true;
}

static bool raw_code(bridge_context *ctx, const vmf_index_info *info,
		     const bridge_value *value, uint64_t *code)
{
	if (info->kind == VMF_FIELD_BOOL) {
		if (value->kind == BRIDGE_BOOL) {
			*code = value->boolean;
			return true;
		}
	} else if (info->kind == VMF_FIELD_SIGNED) {
		if (value->kind == BRIDGE_INT)
			return signed_code(ctx, info, value->i, code);
		if (value->kind == BRIDGE_UINT && value->u <= INT64_MAX)
			return signed_code(
			    ctx, info, static_cast<int64_t>(value->u), code);
		return bridge_fail(ctx, "signed VMF field requires an integer");
	}
	if (value->kind == BRIDGE_UINT) {
		*code = value->u;
		return true;
	}
	if (value->kind == BRIDGE_INT && value->i >= 0) {
		*code = static_cast<uint64_t>(value->i);
		return true;
	}
	return bridge_fail(ctx, "VMF field requires an unsigned integer");
}

static bool event_code(bridge_context *ctx, const vmf_index_info *info,
		       uint64_t code, vmf_field_event *event)
{
	if (code > mask(info))
		return bridge_fail(ctx, "VMF code exceeds field width");
	event->total_units = 1;
	switch (info->kind) {
	case VMF_FIELD_BOOL:
		event->value.boolean.value = code != 0;
		return true;
	case VMF_FIELD_SIGNED:
		return signed_value(ctx, info, code,
				    &event->value.signed_integer.value, false);
	case VMF_FIELD_UNSIGNED:
		event->value.unsigned_integer.value = code;
		return true;
	case VMF_FIELD_ENUM:
		event->value.enumeration.code = code;
		return true;
	case VMF_FIELD_SCALED:
		event->value.scaled.code = code;
		return true;
	default:
		return bridge_fail(ctx, "expected numeric VMF field");
	}
}

static int hex_digit(char code)
{
	if (code >= '0' && code <= '9')
		return code - '0';
	if (code >= 'a' && code <= 'f')
		return code - 'a' + 10;
	if (code >= 'A' && code <= 'F')
		return code - 'A' + 10;
	return -1;
}

static bool hex_option(bridge_context *ctx, const bridge_binding *binding)
{
	return yyjson_equals_str(yyjson_obj_get(binding->options, "encoding"),
				 "hex") ||
	       bridge_fail(ctx, "binary mapping requires encoding hex");
}

static bool binary_encode(bridge_context *ctx, const bridge_binding *binding,
			  const vmf_index_info *info, const bridge_value *value,
			  vmf_field_event *event)
{
	if (!hex_option(ctx, binding))
		return false;
	if (value->kind != BRIDGE_TEXT || value->size % 2)
		return bridge_fail(ctx, "hex requires an even length string");
	size_t size = value->size / 2;
	auto *data = static_cast<uint8_t *>(bridge_alloc(ctx, size ? size : 1));

	if (!data)
		return false;
	for (size_t i = 0; i < size; ++i) {
		int hi = hex_digit(value->text[i * 2]);
		int lo = hex_digit(value->text[i * 2 + 1]);

		if (hi < 0 || lo < 0)
			return bridge_fail(ctx, "invalid hex digit");
		data[i] = static_cast<uint8_t>((hi << 4) | lo);
	}
	if (info->kind == VMF_FIELD_OCTETS) {
		event->total_units = size;
		event->value.octets = {data, size, true};
		return true;
	}
	uint64_t units = static_cast<uint64_t>(size) * 8;
	yyjson_val *bits = yyjson_obj_get(binding->options, "bit_count");

	if (bits) {
		if (!yyjson_is_uint(bits))
			return bridge_fail(
			    ctx, "bit_count requires an unsigned integer");
		units = yyjson_get_uint(bits);
	}
	if (units > SIZE_MAX || units / 8 + (units % 8 != 0) != size ||
	    (units % 8 && (data[size - 1] >> (units % 8))))
		return bridge_fail(
		    ctx, "hex bits length or unused high bits invalid");
	event->total_units = units;
	event->value.bits = {data, static_cast<size_t>(units), true};
	return true;
}

} /* namespace */

bool bridge_value_equal(const bridge_value *a, const bridge_value *b)
{
	return equal(a, b);
}

bool bridge_code_encode(bridge_context *ctx, const vmf_index_info *info,
			uint64_t code, vmf_field_event *event)
{
	*event = {};
	return event_code(ctx, info, code, event);
}

bool bridge_field_encode(bridge_context *ctx, const bridge_binding *binding,
			 const vmf_index_info *info, const bridge_value *value,
			 vmf_field_event *event)
{
	*event = {};
	if (info->kind == VMF_FIELD_TEXT) {
		if (value->kind != BRIDGE_TEXT)
			return bridge_fail(ctx, "VMF text requires a string");
		event->value.text = {value->text, value->size, true};
		return true;
	}
	if (info->kind == VMF_FIELD_OCTETS || info->kind == VMF_FIELD_BITS)
		return binary_encode(ctx, binding, info, value, event);
	const vmf_index_info *definition = info;
	uint64_t code = 0;

	if (binding->cot_id < 0) {
		if (!raw_code(ctx, info, value, &code))
			return false;
		return event_code(ctx, info, code, event);
	}
	if (table_lookup(binding, value, &code))
		return event_code(ctx, info, code, event);
	fraction factor, offset;

	if (!transform(ctx, binding, &factor, &offset))
		return false;
	if (!factor.negative &&
	    !compare(&factor.numerator, &factor.denominator) &&
	    !offset.numerator.count && info->kind != VMF_FIELD_SCALED &&
	    value->kind != BRIDGE_REAL) {
		if (!raw_code(ctx, info, value, &code))
			return false;
		return event_code(ctx, info, code, event);
	}
	fraction number, stage;

	/* Preserve exact fractions through binding and schema transforms,
	 * divide into a bounded integer and remainder, then round and diagnose
	 * quantization from that remainder before checking the field range.
	 */
	if (!fraction_value(value, &number))
		return bridge_fail(
		    ctx, "numeric mapping requires a number or table");
	if (!difference(&number, &offset, &stage) ||
	    !divide(&stage, &factor, &number))
		return bridge_fail(ctx, "numeric precision exhausted");
	if (info->kind == VMF_FIELD_SCALED) {
		fraction scale = schema_fraction(definition->scale->factor);
		fraction bias = schema_fraction(definition->scale->bias);

		if (!scale.numerator.count)
			return bridge_fail(ctx, "VMF scale is not invertible");
		if (!difference(&number, &bias, &stage) ||
		    !divide(&stage, &scale, &number))
			return bridge_fail(ctx,
					   "numeric precision exhausted");
	}
	bool is_signed =
	    info->kind == VMF_FIELD_SIGNED ||
	    (info->kind == VMF_FIELD_SCALED &&
	     definition->integer.representation != VMF_INTEGER_UNSIGNED &&
	     definition->integer.representation != VMF_INTEGER_DEFAULT);
	int64_t signed_number = 0;

	if (!integer(ctx, &number, is_signed, &code, &signed_number))
		return false;
	if (is_signed && !signed_code(ctx, definition, signed_number, &code))
		return false;
	if (info->kind == VMF_FIELD_SCALED && sentinel(definition, code))
		return bridge_fail(ctx,
				   "scaled sentinel requires a values table");
	return event_code(ctx, info, code, event);
}
