#include <gtest/gtest.h>
#include <cot2vmf/core.h>
#include <string>
#include <yyjson.h>

namespace
{

struct catalog_owner {
	cv_buffer bytes = {};
	cv_error error = {};
	yyjson_doc *document = nullptr;

	~catalog_owner()
	{
		yyjson_doc_free(document);
		cv_buffer_destroy(&bytes);
	}

	cv_status load(const std::string &source)
	{
		auto status = cv_catalog(
			reinterpret_cast<const uint8_t *>(source.data()),
			source.size(), &bytes, &error);

		if (status == CV_OK)
			document = yyjson_read(
				reinterpret_cast<const char *>(bytes.data),
				bytes.size, 0);
		return status;
	}
};

std::string message(const std::string &standard)
{
	return "{\"message_number\":\"K01.1\"," + standard +
		"\"indexes\":[{\"index_number\":\"1.\",\"number_of_bits\":8,"
		"\"key\":\"value\"}]}";
}

std::string workspace(const std::string &messages,
	const std::string &properties = "")
{
	return "{\"format\":\"cot-vmf-workspace/1\",\"schemas\":[{"
		"\"id\":\"shared\",\"document\":{\"format\":\"vmf-schema/1\"," +
		properties + "\"messages\":[" + messages +
		"]}}],\"outputs\":[]}";
}

yyjson_val *catalog_message(catalog_owner *owner, size_t ordinal)
{
	auto *root = yyjson_doc_get_root(owner->document);
	auto *schema = yyjson_arr_get(yyjson_obj_get(root, "schemas"), 0);

	return yyjson_arr_get(yyjson_obj_get(schema, "messages"), ordinal);
}

yyjson_val *variant(yyjson_val *message, const char *profile)
{
	return yyjson_obj_get(yyjson_obj_get(message, "profiles"), profile);
}

void expect_available(yyjson_val *message, const char *profile,
	bool present, unsigned version)
{
	auto *value = variant(message, profile);

	ASSERT_TRUE(yyjson_is_obj(value));
	EXPECT_TRUE(yyjson_is_true(yyjson_obj_get(value, "available")));
	EXPECT_STREQ("", yyjson_get_str(yyjson_obj_get(value, "diagnostic")));
	auto *id = yyjson_obj_get(value, "identity");
	auto *wire_version = yyjson_obj_get(id, "standard_version");

	ASSERT_TRUE(yyjson_is_obj(id));
	EXPECT_EQ(2u, yyjson_get_uint(yyjson_obj_get(id,
		"user_message_format")));
	if (present)
		EXPECT_EQ(version, yyjson_get_uint(wire_version));
	else
		EXPECT_TRUE(!wire_version || yyjson_is_null(wire_version));
	auto *header = yyjson_obj_get(value, "header");
	auto *fields = yyjson_obj_get(header, "fields");
	auto *descriptor = yyjson_arr_get(yyjson_obj_get(fields, "messages"), 0);

	ASSERT_TRUE(yyjson_is_obj(header));
	EXPECT_TRUE(yyjson_equals(id, yyjson_obj_get(descriptor, "id")));
}

void expect_unavailable(yyjson_val *message, const char *profile)
{
	auto *value = variant(message, profile);

	ASSERT_TRUE(yyjson_is_obj(value));
	EXPECT_TRUE(yyjson_is_false(yyjson_obj_get(value, "available")));
	auto *diagnostic = yyjson_obj_get(value, "diagnostic");

	ASSERT_TRUE(yyjson_is_str(diagnostic));
	EXPECT_GT(yyjson_get_len(diagnostic), 0u);
	EXPECT_TRUE(yyjson_is_null(yyjson_obj_get(value, "identity")));
	EXPECT_TRUE(yyjson_is_null(yyjson_obj_get(value, "header")));
}

TEST(Catalog, PortableMessageSharesFieldsAcrossFourEnvelopeVariants)
{
	std::string source = workspace(message(
		"\"message_standard\":\"MIL-STD-6017B\","));
	const auto original = source;
	catalog_owner owner;

	ASSERT_EQ(CV_OK, owner.load(source)) << owner.error.message;
	ASSERT_NE(nullptr, owner.document);
	EXPECT_EQ(original, source);
	auto *root = yyjson_doc_get_root(owner.document);

	EXPECT_STREQ("cot-vmf-catalog/1",
		yyjson_get_str(yyjson_obj_get(root, "format")));
	auto *item = catalog_message(&owner, 0);

	ASSERT_TRUE(yyjson_is_obj(item));
	EXPECT_EQ(0u, yyjson_get_uint(yyjson_obj_get(item, "ordinal")));
	EXPECT_STREQ("K01.1",
		yyjson_get_str(yyjson_obj_get(item, "message_number")));
	EXPECT_EQ(nullptr, yyjson_obj_get(item, "identity"));
	EXPECT_EQ(nullptr, yyjson_obj_get(item, "header"));
	EXPECT_EQ(4u, yyjson_obj_size(yyjson_obj_get(item, "profiles")));
	auto *fields = yyjson_obj_get(item, "fields");

	ASSERT_EQ(1u, yyjson_arr_size(fields));
	EXPECT_STREQ("value", yyjson_get_str(
		yyjson_obj_get(yyjson_arr_get(fields, 0), "key")));
	expect_available(item, "B", false, 0);
	expect_available(item, "C", true, 8);
	expect_available(item, "D", true, 7);
	expect_available(item, "D1", true, 7);
}

TEST(Catalog, EachOrdinalBindsDespiteUnrelatedIncompatibleEditions)
{
	catalog_owner owner;
	std::string source = workspace(
		message("\"message_standard\":\"TIDP-TE-R7\",") + "," +
		message("\"message_standard\":\"MIL-STD-6017E\","));

	ASSERT_EQ(CV_OK, owner.load(source)) << owner.error.message;
	ASSERT_NE(nullptr, owner.document);
	auto *first = catalog_message(&owner, 0);
	auto *second = catalog_message(&owner, 1);

	ASSERT_TRUE(yyjson_is_obj(first));
	ASSERT_TRUE(yyjson_is_obj(second));
	EXPECT_EQ(1u, yyjson_get_uint(yyjson_obj_get(second, "ordinal")));
	EXPECT_EQ(1u, yyjson_arr_size(yyjson_obj_get(first, "fields")));
	EXPECT_EQ(1u, yyjson_arr_size(yyjson_obj_get(second, "fields")));
	expect_available(first, "B", false, 0);
	expect_available(second, "B", false, 0);
	expect_available(first, "C", true, 5);
	expect_unavailable(second, "C");
	for (const char *profile : {"D", "D1"}) {
		expect_unavailable(first, profile);
		expect_available(second, profile, true, 10);
	}
}

TEST(Catalog, RawCodesRetainTheirSourceProfileRestriction)
{
	catalog_owner owner;
	auto source = workspace(message("\"standard_version\":8,"),
		"\"envelope\":\"C\",");

	ASSERT_EQ(CV_OK, owner.load(source)) << owner.error.message;
	ASSERT_NE(nullptr, owner.document);
	auto *item = catalog_message(&owner, 0);

	expect_available(item, "C", true, 8);
	for (const char *profile : {"B", "D", "D1"})
		expect_unavailable(item, profile);
	EXPECT_EQ(1u, yyjson_arr_size(yyjson_obj_get(item, "fields")));
}

TEST(Catalog, SelectedOverrideIgnoresUnusedIncompatibleSharedDefault)
{
	catalog_owner owner;
	auto source = workspace(message(
		"\"message_standard\":\"MIL-STD-6017B\","),
		"\"envelope\":\"C\",\"message_standard\":\"TIDP-TE-R7\",");

	ASSERT_EQ(CV_OK, owner.load(source)) << owner.error.message;
	ASSERT_NE(nullptr, owner.document);
	auto *item = catalog_message(&owner, 0);

	expect_available(item, "D1", true, 7);
}

} /* namespace */
