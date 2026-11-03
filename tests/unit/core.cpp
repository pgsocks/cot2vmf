#include <gtest/gtest.h>
#include <cot2vmf/core.hpp>
#include "../../src/core/feedback.h"
#include <cot/inspect.h>
#include <vmf/schema_json.h>
#include <cstring>
#include <string>
#include <thread>
#include <vector>
#include <yyjson.h>

namespace
{

const char empty_workspace[] = "{\"format\":\"cot-vmf-workspace/1\","
			       "\"schemas\":[],\"outputs\":[]}";

std::string event(const std::string &detail = "")
{
	return "<event version=\"2.0\" type=\"a-f-G\" uid=\"synthetic\" "
	       "how=\"m-g\" time=\"2024-01-01T00:00:00Z\" "
	       "start=\"2024-01-01T00:00:00Z\" "
	       "stale=\"2024-01-01T00:01:00Z\">"
	       "<point lat=\"38\" lon=\"-77\" hae=\"10\" ce=\"2\" le=\"3\"/>" +
	       detail + "</event>";
}

std::string schema(const std::string &elements,
		   const std::string &properties = "")
{
	return R"({"format":"vmf-schema/1","message_standard":"MIL-STD-6017B",)"
		R"("messages":[{"message_number":"K01.1","elements":[)" +
	       elements + "]" + properties + "}]}";
}

const char field[] = R"({"key":"value","number_of_bits":8})";

std::string mapping(const std::string &fields, const std::string &extra = "")
{
	return "{\"format\":\"cot-vmf-mapping-config/1\",\"schema\":\"s\","
	       "\"message\":0,\"envelope\":\"C\",\"fields\":[" + fields + "]" +
	       extra + "}";
}

const char latitude[] = "{\"cot\":\"point.latitude\","
			"\"vmf\":{\"key\":\"value\"}}";

std::string output(const std::string &id, const std::string &config,
		   bool enabled = true)
{
	return "{\"id\":\"" + id +
	       "\",\"enabled\":" + (enabled ? "true" : "false") +
	       ",\"mapping\":" + config + "}";
}

std::string workspace(const std::string &definition, const std::string &outputs)
{
	return "{\"format\":\"cot-vmf-workspace/1\",\"schemas\":[{"
	       "\"id\":\"s\",\"document\":" +
	       definition + "}],\"outputs\":[" + outputs + "]}";
}

struct packet {
	std::string id;
	std::vector<uint8_t> bytes;
};

struct sink {
	std::vector<packet> packets;
	std::string fail;
};

bool publish(void *context, const char *id, const uint8_t *bytes, size_t size)
{
	auto *target = static_cast<sink *>(context);

	target->packets.push_back({id, {bytes, bytes + size}});
	return target->fail != id;
}

struct owner {
	cv_workspace *value = nullptr;
	cv_error error = {};

	~owner()
	{
		cv_workspace_destroy(value);
	}

	cv_status load(const std::string &json)
	{
		return cv_workspace_load(
			reinterpret_cast<const uint8_t *>(json.data()),
			json.size(), &value, &error);
	}
};

cv_status process(owner *loaded, const std::string &xml, sink *target,
		  cv_activity *activity)
{
	return cv_process(loaded ? loaded->value : nullptr,
			  reinterpret_cast<const uint8_t *>(xml.data()),
			  xml.size(), target ? publish : nullptr, target,
			  activity, loaded ? &loaded->error : nullptr);
}

struct feedback_record {
	std::string id;
	cv_output_outcome outcome;
	std::string code;
	std::string message;
	std::string config_path;
	std::string target_index;
	int cot_id;
	size_t published;
};

struct feedback_sink {
	std::vector<feedback_record> records;
	const sink *publications = nullptr;
};

void observe(void *context, const cv_output_feedback *feedback)
{
	auto *target = static_cast<feedback_sink *>(context);

	ASSERT_NE(nullptr, feedback);
	ASSERT_NE(nullptr, feedback->output_id);
	ASSERT_NE(nullptr, feedback->code);
	ASSERT_NE(nullptr, feedback->message);
	ASSERT_NE(nullptr, feedback->config_path);
	ASSERT_NE(nullptr, feedback->target_index);
	size_t published =
		target->publications ? target->publications->packets.size() : 0;

	target->records.push_back(
		{feedback->output_id, feedback->outcome, feedback->code,
		 feedback->message, feedback->config_path,
		 feedback->target_index, feedback->cot_id, published});
}

cv_status process_feedback(owner *loaded, const std::string &xml, sink *target,
			   cv_activity *activity, feedback_sink *feedback)
{
	return cv_process_with_feedback(
		loaded ? loaded->value : nullptr,
		reinterpret_cast<const uint8_t *>(xml.data()), xml.size(),
		target ? publish : nullptr, target, activity,
		loaded ? &loaded->error : nullptr, observe, feedback);
}

struct decoded {
	std::vector<uint64_t> values;
	std::vector<uint8_t> bytes;
	std::string text;
	vmf_message_id identity = {};
};

decoded decode(const std::string &definition, const packet &data,
		 vmf_envelope_version profile = VMF_ENVELOPE_C,
		 size_t ordinal = 0)
{
	auto loading = vmf_schema_json_default_options();
	vmf_schema_json_document *document = nullptr;
	decoded result;

	EXPECT_EQ(VMF_OK,
		  vmf_schema_json_load(definition.data(), definition.size(),
				       &loading, &document, nullptr));
	const auto *source = vmf_schema_json_schemas(document);

	if (!source || ordinal >= source->message_count) {
		ADD_FAILURE() << "decoder fixture message is unavailable";
		vmf_schema_json_destroy(document);
		return result;
	}
	vmf_schema_set selected = *source;
	selected.messages = source->messages + ordinal;
	selected.message_count = 1;
	if (selected.messages->standard.kind != VMF_STANDARD_INHERIT)
		selected.standard = selected.messages->standard;
	auto options = vmf_options_for_schemas(&selected);
	options.profile = profile;
	vmf_decoder *decoder = nullptr;

	EXPECT_EQ(VMF_OK, vmf_decoder_create(&options, &decoder, nullptr));
	EXPECT_EQ(VMF_OK, vmf_decoder_begin_pdu(decoder));
	vmf_input input = {data.bytes.data(), data.bytes.size(), 0, true};
	vmf_status status = VMF_OK;

	while (status == VMF_OK) {
		vmf_event next = {};

		status = vmf_decoder_next(decoder, &input, &next);
		if (status == VMF_OK && next.kind == VMF_EVENT_MESSAGE_BEGIN)
			result.identity = next.as.message.id;
		if (status != VMF_OK || next.kind != VMF_EVENT_FIELD)
			continue;
		if (next.field_kind == VMF_FIELD_TEXT)
			result.text.append(next.as.field.value.text.data,
					   next.as.field.value.text.size);
		else if (next.field_kind == VMF_FIELD_BITS) {
			const auto &bits = next.as.field.value.bits;

			result.bytes.insert(result.bytes.end(), bits.data,
					    bits.data +
						    (bits.bit_count + 7) / 8);
		} else if (next.field_kind == VMF_FIELD_OCTETS) {
			const auto &octets = next.as.field.value.octets;

			result.bytes.insert(result.bytes.end(), octets.data,
					    octets.data + octets.size);
		} else if (next.field_kind == VMF_FIELD_SCALED)
			result.values.push_back(
				next.as.field.value.scaled.code);
		else if (next.field_kind == VMF_FIELD_ENUM)
			result.values.push_back(
				next.as.field.value.enumeration.code);
		else if (next.field_kind == VMF_FIELD_SIGNED)
			result.values.push_back(static_cast<uint64_t>(
				next.as.field.value.signed_integer.value));
		else
			result.values.push_back(
				next.as.field.value.unsigned_integer.value);
	}
	EXPECT_EQ(VMF_DONE, status);
	EXPECT_EQ(input.size, input.used);
	vmf_decoder_destroy(decoder);
	vmf_schema_json_destroy(document);
	return result;
}

std::string replace(std::string value, const std::string &before,
		    const std::string &after)
{
	auto position = value.find(before);

	if (position != std::string::npos)
		value.replace(position, before.size(), after);
	return value;
}

TEST(Core, NestedSchemaDiagnosticsIdentifyPrimaryAndRelatedSources)
{
	owner unknown;
	std::string definition = schema(
		R"({"optional":{"key":"v","type":"bits",)"
		R"("number_of_bits":8,"length_from":"missing"}})");

	EXPECT_EQ(CV_INVALID_CONFIG,
		unknown.load(workspace(definition, "")));
	EXPECT_NE(std::string::npos, std::string(unknown.error.message).find(
		"/messages/0/elements/0/optional/length_from"));
	owner duplicate;

	definition = schema(R"({"key":"v","number_of_bits":8},)"
		R"({"optional":{"key":"v","number_of_bits":8}})");
	EXPECT_EQ(CV_INVALID_CONFIG,
		duplicate.load(workspace(definition, "")));
	std::string diagnostic = duplicate.error.message;

	EXPECT_NE(std::string::npos, diagnostic.find(
		"/messages/0/elements/1/optional/key"));
	EXPECT_NE(std::string::npos, diagnostic.find(
		"/messages/0/elements/0/key"));
}

TEST(Core, MappingDestinationsRequireStableFieldKeys)
{
	for (const char *target : {R"({"index":"1"})", R"({"index":[1]})"}) {
		owner loaded;
		std::string binding =
			R"({"cot":"point.latitude","vmf":)" +
			std::string(target) + "}";

		EXPECT_EQ(CV_INVALID_CONFIG, loaded.load(workspace(schema(field),
			output("numeric", mapping(binding)))));
	}
}

TEST(Core, ReceiveOnlyDecodesAndReportsPresentFields)
{
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(nullptr, event(), nullptr, &activity));
	EXPECT_TRUE(activity.decoded);
	EXPECT_TRUE(activity.present_fields &
		    (UINT64_C(1) << (COT_FIELD_LATITUDE - 1)));
	EXPECT_FALSE(activity.present_fields &
		     (UINT64_C(1) << (COT_FIELD_CONTACT_CALLSIGN - 1)));
	EXPECT_EQ(0u, activity.outputs_succeeded);
	EXPECT_EQ(0u, activity.outputs_failed);
	EXPECT_EQ(CV_INVALID_COT,
		  process(nullptr, "<event>confidential</event>", nullptr,
			  &activity));
	EXPECT_FALSE(activity.decoded);
	EXPECT_EQ(0u, activity.present_fields);
}

TEST(Core, SubsetFeedbackReportsSuccessfulIntendedOutput)
{
	std::string definition = schema(std::string(field) +
		R"(,{"optional":{"key":"optional","number_of_bits":14,)"
		R"("type":"literal"}},{"key":"conditional","number_of_bits":8,)"
		R"("when":{"all":[{"field":"value","values":[{"first":1,)"
		R"("last":1}]}]}},{"key":"fixed","number_of_bits":8})");
	std::string extra = ",\"vmf_constants\":[{\"vmf\":{\"key\":\"fixed\"},"
			    "\"value\":7}]";
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 definition,
				 output("subset", mapping(latitude, extra)) +
				 "," + output("paused", "{}", false))))
		<< loaded.error.message;
	sink target;
	feedback_sink feedback;
	feedback.publications = &target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK,
		  process_feedback(
			  &loaded, event("<detail><custom value=\"secret\"/>"
					 "</detail>"),
			  &target, &activity, &feedback))
		<< loaded.error.message;
	ASSERT_EQ(1u, feedback.records.size());
	const auto &result = feedback.records[0];

	EXPECT_EQ("subset", result.id);
	EXPECT_EQ(CV_OUTPUT_SENT, result.outcome);
	EXPECT_TRUE(result.code.empty());
	EXPECT_TRUE(result.message.empty());
	EXPECT_TRUE(result.config_path.empty());
	EXPECT_TRUE(result.target_index.empty());
	EXPECT_EQ(-1, result.cot_id);
	EXPECT_EQ(1u, result.published);
	EXPECT_EQ(1u, activity.outputs_succeeded);
	EXPECT_EQ(0u, activity.outputs_failed);
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ((std::vector<uint64_t>{38, 7}),
		  decode(definition, target.packets[0]).values);
}

TEST(Core, FeedbackIsPerOutputAndPreservesFirstErrorAndRecovery)
{
	std::string longitude = "{\"cot\":\"point.longitude\","
				"\"vmf\":{\"key\":\"value\"}}";
	std::string outputs = output("conversion", mapping(longitude)) + "," +
			      output("send", mapping(latitude)) + "," +
			      output("success", mapping(latitude));
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(schema(field), outputs)))
		<< loaded.error.message;
	sink target;
	target.fail = "send";
	feedback_sink feedback;
	feedback.publications = &target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OUTPUT_ERROR, process_feedback(
					  &loaded, event(), &target, &activity,
					  &feedback));
	ASSERT_EQ(3u, feedback.records.size());
	const auto first = feedback.records[0];

	EXPECT_EQ("conversion", first.id);
	EXPECT_EQ(CV_OUTPUT_NOT_ENCODED, first.outcome);
	EXPECT_EQ("mapped_value", first.code);
	EXPECT_FALSE(first.message.empty());
	EXPECT_EQ(loaded.error.message, first.message);
	EXPECT_EQ("/fields/0", first.config_path);
	EXPECT_EQ("1", first.target_index);
	EXPECT_EQ(COT_FIELD_LONGITUDE, first.cot_id);
	EXPECT_EQ(0u, first.published);
	const auto &send = feedback.records[1];

	EXPECT_EQ("send", send.id);
	EXPECT_EQ(CV_OUTPUT_SEND_FAILED, send.outcome);
	EXPECT_EQ("publication", send.code);
	EXPECT_EQ("VMF output publication failed", send.message);
	EXPECT_TRUE(send.config_path.empty());
	EXPECT_TRUE(send.target_index.empty());
	EXPECT_EQ(-1, send.cot_id);
	EXPECT_EQ(1u, send.published);
	EXPECT_EQ("success", feedback.records[2].id);
	EXPECT_EQ(CV_OUTPUT_SENT, feedback.records[2].outcome);
	EXPECT_EQ(2u, feedback.records[2].published);
	EXPECT_EQ(2u, activity.outputs_failed);
	EXPECT_EQ(1u, activity.outputs_succeeded);
	sink legacy;
	legacy.fail = "send";
	cv_activity previous = {};

	EXPECT_EQ(CV_OUTPUT_ERROR,
		  process(&loaded, event(), &legacy, &previous));
	EXPECT_EQ(first.message, loaded.error.message);
	EXPECT_EQ(activity.outputs_failed, previous.outputs_failed);
	EXPECT_EQ(activity.outputs_succeeded, previous.outputs_succeeded);
	ASSERT_EQ(target.packets.size(), legacy.packets.size());
	for (size_t i = 0; i < target.packets.size(); ++i)
		EXPECT_EQ(target.packets[i].bytes, legacy.packets[i].bytes);
	ASSERT_EQ(CV_OUTPUT_ERROR,
		  process_feedback(&loaded, replace(event(), "lon=\"-77\"",
					    "lon=\"77\""),
				   &target, &activity, &feedback));
	ASSERT_EQ(6u, feedback.records.size());
	EXPECT_EQ(CV_OUTPUT_SENT, feedback.records[3].outcome);
	EXPECT_TRUE(feedback.records[3].message.empty());
	EXPECT_TRUE(feedback.records[3].config_path.empty());
	EXPECT_TRUE(feedback.records[3].target_index.empty());
	cv_workspace_destroy(loaded.value);
	loaded.value = nullptr;
	EXPECT_EQ(first.message, feedback.records[0].message);
	EXPECT_EQ("/fields/0", feedback.records[0].config_path);
	EXPECT_EQ("1", feedback.records[0].target_index);
}

TEST(Core, FeedbackDoesNotInventLocationForOversizedMessage)
{
	std::string definition =
		schema(R"({"key":"value","number_of_bits":524064,"type":"text",)"
			R"("text_encoding":"ascii_8"})");
	std::string extra = ",\"vmf_constants\":[{\"vmf\":{\"key\":\"value\"},"
			    "\"value\":\"" +
			    std::string(65508, 'A') + "\"}]";
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(definition,
					output("large", mapping("", extra)))))
		<< loaded.error.message;
	sink target;
	feedback_sink feedback;
	cv_activity activity = {};

	ASSERT_EQ(CV_OUTPUT_ERROR, process_feedback(
					  &loaded, event(), &target, &activity,
					  &feedback));
	ASSERT_EQ(1u, feedback.records.size());
	const auto &result = feedback.records[0];

	EXPECT_EQ(CV_OUTPUT_NOT_ENCODED, result.outcome);
	EXPECT_EQ("vmf_encode", result.code);
	EXPECT_NE(std::string::npos, result.message.find("UDP"));
	EXPECT_TRUE(result.config_path.empty());
	EXPECT_TRUE(result.target_index.empty());
	EXPECT_EQ(-1, result.cot_id);
	EXPECT_TRUE(target.packets.empty());
}

TEST(Core, InvalidInputAndReceiveOnlyProduceNoOutputFeedback)
{
	sink target;
	feedback_sink feedback;
	cv_activity activity = {};

	EXPECT_EQ(CV_OK, process_feedback(nullptr, event(), nullptr, &activity,
					  &feedback));
	EXPECT_TRUE(feedback.records.empty());
	EXPECT_EQ(CV_INVALID_COT,
		  process_feedback(nullptr, "secret-marker", &target, &activity,
				   &feedback));
	EXPECT_TRUE(feedback.records.empty());
	EXPECT_FALSE(activity.decoded);
}

TEST(Core, FeedbackRemainsIndependentAcrossConcurrentCalls)
{
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 schema(field),
				 output("concurrent", mapping(latitude)))))
		<< loaded.error.message;
	std::vector<std::thread> threads;
	std::vector<sink> targets(8);
	std::vector<feedback_sink> feedback(8);
	std::vector<cv_activity> activities(8);
	std::vector<cv_status> statuses(8);
	std::string xml = event();

	for (size_t i = 0; i < targets.size(); ++i)
		threads.emplace_back([&, i]() {
			feedback[i].publications = &targets[i];
			statuses[i] = cv_process_with_feedback(
				loaded.value,
				reinterpret_cast<const uint8_t *>(xml.data()),
				xml.size(), publish, &targets[i],
				&activities[i], nullptr, observe, &feedback[i]);
		});
	for (auto &thread : threads)
		thread.join();
	for (size_t i = 0; i < targets.size(); ++i) {
		EXPECT_EQ(CV_OK, statuses[i]);
		ASSERT_EQ(1u, feedback[i].records.size());
		EXPECT_EQ("concurrent", feedback[i].records[0].id);
		EXPECT_EQ(CV_OUTPUT_SENT, feedback[i].records[0].outcome);
		EXPECT_EQ(1u, feedback[i].records[0].published);
		EXPECT_TRUE(feedback[i].records[0].message.empty());
	}
}

TEST(Core, EmptyWorkspaceAndDisabledDraftAreValid)
{
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(empty_workspace)) << loaded.error.message;
	cv_activity activity = {};

	EXPECT_EQ(CV_OK, process(&loaded, event(), nullptr, &activity));
	owner draft;

	ASSERT_EQ(CV_OK, draft.load(workspace(schema(field),
					      output("draft", "{}", false))))
		<< draft.error.message;
	EXPECT_EQ(CV_OK, process(&draft, event(), nullptr, &activity));
}

TEST(Core, EmbeddedSchemasAndMappingOwnTheirInput)
{
	std::string definition = schema(field);
	std::string json =
		workspace(definition, output("position", mapping(latitude)));
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(json)) << loaded.error.message;
	json.assign(json.size(), 'x');
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ("position", target.packets[0].id);
	EXPECT_EQ((std::vector<uint64_t>{38}),
		  decode(definition, target.packets[0]).values);
	EXPECT_EQ(1u, activity.outputs_succeeded);
}

TEST(Core, RuntimeOptionsCannotBeStoredInWorkspace)
{
	for (const std::string &settings :
	     {"{}", "{\"cot_listen\":\"0.0.0.0:9001\"}",
	      "{\"vmf_target\":\"127.0.0.1:9002\"}",
	      "{\"web_listen\":null}", "{\"log_format\":\"json\"}"}) {
		std::string json = std::string(empty_workspace);
		json.pop_back();
		json += ",\"service\":" + settings + "}";
		owner loaded;

		EXPECT_EQ(CV_INVALID_CONFIG, loaded.load(json));
		EXPECT_EQ(nullptr, loaded.value);
	}
}

TEST(Core, OptionalSourceCannotLeakAcrossEvents)
{
	std::string definition = schema(
		R"({"optional":{"key":"value","type":"literal",)"
		R"("number_of_bits":14}})");
	std::string binding = "{\"cot\":\"detail.contact.callsign\","
			      "\"vmf\":{\"key\":\"value\"}}";
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(definition,
					output("optional", mapping(binding)))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK,
		  process(&loaded,
			  event("<detail><contact callsign=\"AB\"/></detail>"),
			  &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(2u, target.packets.size());
	EXPECT_EQ("AB", decode(definition, target.packets[0]).text);
	EXPECT_TRUE(decode(definition, target.packets[1]).text.empty());
	EXPECT_FALSE(activity.present_fields &
		     (UINT64_C(1) << (COT_FIELD_CONTACT_CALLSIGN - 1)));
}

TEST(Core, FailedConversionDoesNotBlockOtherOutputs)
{
	std::string mandatory = mapping("{\"cot\":\"detail.status.battery\","
					"\"vmf\":{\"key\":\"value\"}}");
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(
			  schema(field),
			  output("missing", mandatory) + "," +
				  output("position", mapping(latitude)))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	EXPECT_EQ(CV_OUTPUT_ERROR,
		  process(&loaded, event(), &target, &activity));
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ("position", target.packets[0].id);
	EXPECT_EQ(1u, activity.outputs_failed);
	EXPECT_EQ(1u, activity.outputs_succeeded);
}

TEST(Core, FailedPublicationDoesNotBlockOtherOutputs)
{
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 schema(field),
				 output("first", mapping(latitude)) + "," +
					 output("second", mapping(latitude)))))
		<< loaded.error.message;
	sink target;
	target.fail = "first";
	cv_activity activity = {};

	EXPECT_EQ(CV_OUTPUT_ERROR,
		  process(&loaded, event(), &target, &activity));
	ASSERT_EQ(2u, target.packets.size());
	EXPECT_EQ(1u, activity.outputs_failed);
	EXPECT_EQ(1u, activity.outputs_succeeded);
	EXPECT_EQ(CV_OUTPUT_ERROR, loaded.error.status);
}

TEST(Core, ScaleAndBindingTransformsEncodeCheckedRawCodes)
{
	std::string definition = schema(
		R"({"key":"value","number_of_bits":16,)"
			R"("scale":{"factor":{"numerator":1,"denominator":10},)"
			R"("bias":{"numerator":0,"denominator":1}}})");
	std::string binding =
		"{\"cot\":\"point.latitude\","
		"\"vmf\":{\"key\":\"value\"},\"factor\":2,\"offset\":2}";
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(definition,
					output("scaled", mapping(binding)))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ((std::vector<uint64_t>{180}),
		  decode(definition, target.packets[0]).values);
}

TEST(Core, LookupAndFixedRepeatsRetainExactValues)
{
	std::string definition = schema(
		R"({"repeat":{"count":2,"body":{"key":"value",)"
		R"("number_of_bits":8}}})");
	std::string binding =
		"{\"cot\":\"uid\",\"vmf\":{\"key\":\"value\"},"
		"\"occurrences\":[{\"repeat\":1,\"index\":0}],"
		"\"values\":[{\"cot\":\"synthetic\",\"vmf\":255}]}";
	std::string extra =
		",\"vmf_constants\":[{\"vmf\":{\"key\":\"value\"},"
		"\"value\":9,\"occurrences\":[{\"repeat\":1,\"index\":1}]}]";
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 definition,
				 output("repeat", mapping(binding, extra)))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ((std::vector<uint64_t>{255, 9}),
		  decode(definition, target.packets[0]).values);
}

TEST(Core, LookupKeysUseExactNativeNumericDomains)
{
	for (const char *rows : {
		     "{\"cot\":38,\"vmf\":1},{\"cot\":38.0,\"vmf\":2}",
		     "{\"cot\":-0.0,\"vmf\":1},{\"cot\":0,\"vmf\":2}",
		     "{\"cot\":9007199254740992,\"vmf\":1},"
		     "{\"cot\":9007199254740992.0,\"vmf\":2}",
		     "{\"cot\":9007199254740993,\"vmf\":1}"}) {
		owner loaded;
		std::string binding =
			"{\"cot\":\"point.hae\",\"vmf\":{\"key\":\"value\"},"
			"\"values\":[" + std::string(rows) + "]}";

		EXPECT_EQ(CV_INVALID_CONFIG,
			  loaded.load(workspace(
				  schema(field),
				  output("invalid", mapping(binding)))));
	}
	for (const char *key : {"1.0", "-1", "4294967296"}) {
		owner loaded;
		std::string binding =
			"{\"cot\":\"detail.status.battery\","
			"\"vmf\":{\"key\":\"value\"},\"values\":[{\"cot\":" +
			std::string(key) + ",\"vmf\":1}]}";

		EXPECT_EQ(CV_INVALID_CONFIG,
			  loaded.load(workspace(
				  schema(field),
				  output("invalid", mapping(binding)))));
	}
	std::string definition =
		schema(R"({"key":"value","number_of_bits":64})");
	std::string binding =
		"{\"cot\":\"send_time_ms\",\"vmf\":{\"key\":\"value\"},"
		"\"factor\":2,\"offset\":1,\"values\":["
		"{\"cot\":18446744073709551615,\"vmf\":1},"
		"{\"cot\":18446744073709551614,\"vmf\":1},"
		"{\"cot\":9007199254740993,\"vmf\":1},"
		"{\"cot\":1704067200000,\"vmf\":18446744073709551615}]}";
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(
			  definition, output("unsigned", mapping(binding)))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ((std::vector<uint64_t>{UINT64_MAX}),
		  decode(definition, target.packets[0]).values);
}

TEST(Core, LookupStringsRetainBoundariesOwnershipAndManyToOneCodes)
{
	std::string definition = schema(field);
	std::string binding =
		"{\"cot\":\"uid\",\"vmf\":{\"key\":\"value\"},\"values\":["
		"{\"cot\":\"synthetica\",\"vmf\":1},"
		"{\"cot\":\"synthetic\\u0000\",\"vmf\":2},"
		"{\"cot\":\"\",\"vmf\":3},"
		"{\"cot\":\"synthetic\",\"vmf\":4},"
		"{\"cot\":\"a\",\"vmf\":4},"
		"{\"cot\":\"\\u00e9\",\"vmf\":4}]}";
	std::string json =
		workspace(definition, output("strings", mapping(binding)));
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(json)) << loaded.error.message;
	json.assign(json.size(), 'x');
	for (const char *source : {"synthetic", "synthetica", "a", "é"}) {
		sink target;
		cv_activity activity = {};

		std::string xml = replace(event(), "synthetic", source);

		ASSERT_EQ(CV_OK, process(&loaded, xml, &target, &activity))
			<< loaded.error.message;
		ASSERT_EQ(1u, target.packets.size());
		uint64_t expected = !std::strcmp(source, "synthetica") ? 1 : 4;

		EXPECT_EQ((std::vector<uint64_t>{expected}),
			  decode(definition, target.packets[0]).values);
	}
	sink missed;
	cv_activity activity = {};

	EXPECT_EQ(CV_OUTPUT_ERROR,
		  process(&loaded, replace(event(), "synthetic", "syntheti"),
			  &missed, &activity));
	EXPECT_TRUE(missed.packets.empty());
}

TEST(Core, LookupRejectsInvalidSourcesRawCodesAndSeparatedDuplicates)
{
	for (const char *rows : {
		     "{\"cot\":true,\"vmf\":1}",
		     "{\"cot\":\"synthetic\",\"vmf\":256}",
		     "{\"cot\":\"synthetic\",\"vmf\":1.0}",
		     "{\"cot\":\"synthetic\",\"vmf\":1},"
		     "{\"cot\":\"synthetica\",\"vmf\":2},"
		     "{\"cot\":\"a\",\"vmf\":1},"
		     "{\"cot\":\"synthetic\",\"vmf\":2}"}) {
		owner loaded;
		std::string binding =
			"{\"cot\":\"uid\",\"vmf\":{\"key\":\"value\"},"
			"\"values\":[" + std::string(rows) + "]}";

		EXPECT_EQ(CV_INVALID_CONFIG,
			  loaded.load(workspace(
				  schema(field),
				  output("invalid", mapping(binding)))));
	}
}

TEST(Core, CompiledLookupSupportsIndependentConcurrentCalls)
{
	std::string binding =
		"{\"cot\":\"point.hae\",\"vmf\":{\"key\":\"value\"},"
		"\"values\":[{\"cot\":7,\"vmf\":70},{\"cot\":0,\"vmf\":10},"
		"{\"cot\":3.0,\"vmf\":30}]}";
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 schema(field),
				 output("concurrent", mapping(binding)))))
		<< loaded.error.message;
	std::vector<std::thread> threads;
	std::vector<sink> targets(8);
	std::vector<cv_activity> activities(8);
	std::vector<cv_status> statuses(8);

	for (size_t i = 0; i < targets.size(); ++i)
		threads.emplace_back([&, i]() {
			std::string xml = replace(event(), "hae=\"10\"",
						  "hae=\"" + std::to_string(i) +
							  "\"");

			statuses[i] = cv_process(
				loaded.value,
				reinterpret_cast<const uint8_t *>(xml.data()),
				xml.size(), publish, &targets[i],
				&activities[i], nullptr);
		});
	for (auto &thread : threads)
		thread.join();
	for (size_t i = 0; i < targets.size(); ++i) {
		ASSERT_EQ(CV_OK, statuses[i]);
		ASSERT_EQ(1u, targets[i].packets.size());
		uint64_t expected = i == 0 ? 10 : i == 3 ? 30 : i == 7 ? 70 : i;

		EXPECT_EQ((std::vector<uint64_t>{expected}),
			  decode(schema(field), targets[i].packets[0]).values);
	}
}

TEST(Core, LargeLookupCompilesAndFindsBoundsAndMisses)
{
	std::string definition =
		schema(R"({"key":"value","number_of_bits":32})");
	std::string binding =
		"{\"cot\":\"point.hae\",\"vmf\":{\"key\":\"value\"},"
		"\"values\":[";

	for (size_t i = 65536; i; --i) {
		if (i != 65536)
			binding += ',';
		binding += "{\"cot\":" + std::to_string(i - 1) +
			   ",\"vmf\":" + std::to_string((i - 1) & 255) + "}";
	}
	binding += "]}";
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(
			  definition, output("large", mapping(binding)))))
		<< loaded.error.message;
	for (uint64_t value : {UINT64_C(0), UINT64_C(38), UINT64_C(65535),
			       UINT64_C(65536)}) {
		sink target;
		cv_activity activity = {};
		std::string xml = replace(
			event(), "hae=\"10\"",
			"hae=\"" + std::to_string(value) + "\"");

		ASSERT_EQ(CV_OK, process(&loaded, xml, &target, &activity))
			<< loaded.error.message;
		ASSERT_EQ(1u, target.packets.size());
		EXPECT_EQ((std::vector<uint64_t>{
				   value == 65536 ? value : value & 255}),
			  decode(definition, target.packets[0]).values);
	}
}

TEST(Core, RejectsInvalidConfigAndDoesNotResolveSchemaPaths)
{
	for (const std::string &json :
	     {std::string("{\"format\":\"cot-vmf-workspace/1\","
			  "\"format\":\"cot-vmf-workspace/"
			  "1\",\"schemas\":[],\"outputs\":[]}"),
	      std::string("{\"format\":\"cot-vmf-workspace/1\",\"schemas\":[],"
			  "\"outputs\":[],\"unknown\":true}"),
	      workspace(schema(field), output("one", "{}")),
	      workspace(schema(field),
			output("one", mapping(latitude)) + "," +
				output("one", mapping(latitude)))}) {
		owner loaded;

		EXPECT_EQ(CV_INVALID_CONFIG, loaded.load(json));
		EXPECT_EQ(nullptr, loaded.value);
		EXPECT_NE('\0', loaded.error.message[0]);
	}
	std::string config = mapping(latitude);
	config.replace(config.find("\"schema\":\"s\""), 12,
		       "\"schema\":\"/tmp/no-schema-opened.json\"");
	owner loaded;

	EXPECT_EQ(
		CV_INVALID_CONFIG,
		loaded.load(workspace(schema(field), output("file", config))));
}

TEST(Core, CatalogRetainsInvalidSchemasAndAllCotFields)
{
	std::string json = workspace("{}", output("draft", "{}", false));
	cv_buffer buffer = {};
	cv_error error = {};

	ASSERT_EQ(CV_OK,
		  cv_catalog(reinterpret_cast<const uint8_t *>(json.data()),
			     json.size(), &buffer, &error))
		<< error.message;
	yyjson_doc *document = yyjson_read(
		reinterpret_cast<const char *>(buffer.data), buffer.size, 0);
	ASSERT_NE(nullptr, document);
	yyjson_val *root = yyjson_doc_get_root(document);

	EXPECT_EQ(cot_field_count(),
		  yyjson_arr_size(yyjson_obj_get(root, "cot")));
	yyjson_val *entry = yyjson_arr_get(yyjson_obj_get(root, "schemas"), 0);

	EXPECT_FALSE(yyjson_get_bool(yyjson_obj_get(entry, "valid")));
	EXPECT_GT(yyjson_get_len(yyjson_obj_get(entry, "diagnostic")), 0u);
	yyjson_doc_free(document);
	cv_buffer_destroy(&buffer);
	EXPECT_EQ(nullptr, buffer.data);
	EXPECT_EQ(0u, buffer.size);
}

TEST(Core, CatalogProvidesExactHeaderAndCanonicalFields)
{
	std::string json =
		workspace(schema(field), output("draft", "{}", false));
	cv_buffer buffer = {};
	cv_error error = {};

	ASSERT_EQ(CV_OK,
		  cv_catalog(reinterpret_cast<const uint8_t *>(json.data()),
			     json.size(), &buffer, &error))
		<< error.message;
	yyjson_doc *document = yyjson_read(
		reinterpret_cast<const char *>(buffer.data), buffer.size, 0);
	ASSERT_NE(nullptr, document);
	yyjson_val *root = yyjson_doc_get_root(document);
	yyjson_val *entry = yyjson_arr_get(yyjson_obj_get(root, "schemas"), 0);
	yyjson_val *message =
		yyjson_arr_get(yyjson_obj_get(entry, "messages"), 0);
	yyjson_val *profiles = yyjson_obj_get(message, "profiles");
	yyjson_val *selected = yyjson_obj_get(profiles, "C");
	yyjson_val *header = yyjson_obj_get(selected, "header");
	yyjson_val *identity = yyjson_obj_get(selected, "identity");

	EXPECT_TRUE(yyjson_get_bool(yyjson_obj_get(selected, "available")));
	yyjson_val *headers =
		yyjson_obj_get(yyjson_obj_get(header, "fields"), "messages");

	EXPECT_TRUE(yyjson_equals(
		identity, yyjson_obj_get(yyjson_arr_get(headers, 0), "id")));
	yyjson_val *target =
		yyjson_arr_get(yyjson_obj_get(message, "fields"), 0);

	EXPECT_TRUE(yyjson_equals_str(yyjson_obj_get(target, "index"), "1"));
	EXPECT_TRUE(yyjson_equals_str(yyjson_obj_get(target, "key"), "value"));
	EXPECT_TRUE(
		yyjson_equals_str(yyjson_obj_get(target, "kind"), "unsigned"));
	yyjson_doc_free(document);
	cv_buffer_destroy(&buffer);
}

TEST(Core, ResidualXmlAndExtensionsArePresenceOnly)
{
	cv_buffer buffer = {};
	cv_error error = {};

	ASSERT_EQ(CV_OK, cv_catalog(nullptr, 0, &buffer, &error));
	yyjson_doc *document = yyjson_read(
		reinterpret_cast<const char *>(buffer.data), buffer.size, 0);
	ASSERT_NE(nullptr, document);
	yyjson_val *sources =
		yyjson_obj_get(yyjson_doc_get_root(document), "cot");

	for (size_t i = 0; i < yyjson_arr_size(sources); ++i) {
		yyjson_val *source = yyjson_arr_get(sources, i);
		uint64_t id = yyjson_get_uint(yyjson_obj_get(source, "id"));

		if (id == COT_FIELD_DETAIL_XML || id == COT_FIELD_EXTENSIONS)
			EXPECT_FALSE(yyjson_get_bool(
				yyjson_obj_get(source, "mappable")));
	}
	yyjson_doc_free(document);
	cv_buffer_destroy(&buffer);
	std::string definition =
		schema(R"({"key":"value","number_of_bits":224,"type":"literal"})");
	owner loaded;

	EXPECT_EQ(CV_INVALID_CONFIG,
		  loaded.load(workspace(
			  definition,
			  output("residual",
				 mapping("{\"cot\":\"detail.xml\","
					 "\"vmf\":{\"key\":\"value\"}}")))));
}

TEST(Core, ArgumentFailuresClearOutputsAndDoNotRevealPayload)
{
	cv_activity activity = {true, UINT64_MAX, 3, 4};
	cv_error error = {};
	const char secret[] = "secret-marker";

	EXPECT_EQ(CV_INVALID_COT,
		  cv_process(nullptr, reinterpret_cast<const uint8_t *>(secret),
			     sizeof(secret) - 1, nullptr, nullptr, &activity,
			     &error));
	EXPECT_EQ(nullptr, std::strstr(error.message, secret));
	EXPECT_FALSE(activity.decoded);
	EXPECT_EQ(0u, activity.present_fields);
	EXPECT_EQ(CV_INVALID_ARGUMENT, cv_process(nullptr, nullptr, 0, nullptr,
						  nullptr, &activity, &error));
	EXPECT_EQ(CV_INVALID_ARGUMENT,
		  cv_workspace_load(nullptr, 0, nullptr, &error));
	cv_buffer buffer = {};

	EXPECT_EQ(CV_OK, cot2vmf::cv_catalog(nullptr, 0, &buffer, &error));
	cv_buffer_destroy(&buffer);
	cv_buffer_destroy(nullptr);
	cv_workspace_destroy(nullptr);
}

TEST(Core, UnsignedConstantsRetainAll64Bits)
{
	std::string definition =
		schema(R"({"key":"value","number_of_bits":64})");
	for (uint64_t value : {UINT64_C(9007199254740993), UINT64_MAX}) {
		std::string extra = ",\"vmf_constants\":[{\"vmf\":{"
				    "\"key\":\"value\"},\"value\":" +
				    std::to_string(value) + "}]";
		owner loaded;

		ASSERT_EQ(CV_OK,
			  loaded.load(workspace(
				  definition,
				  output("constant", mapping("", extra)))))
			<< loaded.error.message;
		sink target;
		cv_activity activity = {};

		ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
			<< loaded.error.message;
		ASSERT_EQ(1u, target.packets.size());
		EXPECT_EQ((std::vector<uint64_t>{value}),
			  decode(definition, target.packets[0]).values);
	}
}

TEST(Core, RoundsHalvesAwayFromZeroAndRejectsOverflow)
{
	for (const char *source : {"0.5", "1.5", "255.5"}) {
		owner loaded;

		ASSERT_EQ(CV_OK, loaded.load(workspace(
					 schema(field),
					 output("rounded", mapping(latitude)))))
			<< loaded.error.message;
		sink target;
		cv_activity activity = {};
		std::string xml =
			replace(event(), "lat=\"38\"",
				"lat=\"" + std::string(source) + "\"");
		cv_status status = process(&loaded, xml, &target, &activity);

		if (!std::strcmp(source, "255.5")) {
			EXPECT_EQ(CV_INVALID_COT, status);
			EXPECT_TRUE(target.packets.empty());
		} else {
			ASSERT_EQ(CV_OK, status) << loaded.error.message;
			ASSERT_EQ(1u, target.packets.size());
			EXPECT_EQ(
				(std::vector<uint64_t>{
					!std::strcmp(source, "0.5") ? 1u : 2u}),
				decode(schema(field), target.packets[0])
					.values);
		}
	}
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 schema(field),
				 output("overflow",
					mapping("{\"cot\":\"point.latitude\","
						"\"vmf\":{\"key\":\"value\"},"
						"\"factor\":0.1}")))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	EXPECT_EQ(CV_OUTPUT_ERROR,
		  process(&loaded, event(), &target, &activity));
	EXPECT_TRUE(target.packets.empty());
}

TEST(Core, BinaryFieldsRequireCompleteBoundedHexAndZeroHighBits)
{
	std::string definition =
		schema(R"({"key":"value","number_of_bits":9,"type":"bits"})");
	std::string binding = "{\"cot\":\"uid\",\"vmf\":{\"key\":\"value\"},"
			      "\"encoding\":\"hex\",\"bit_count\":9}";
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 definition, output("bits", mapping(binding)))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, replace(event(), "synthetic", "ff01"),
				 &target, &activity));
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ((std::vector<uint8_t>{255, 1}),
		  decode(definition, target.packets[0]).bytes);
	for (const char *bad : {"ff03", "f", "zz01"}) {
		target.packets.clear();
		EXPECT_EQ(CV_OUTPUT_ERROR,
			  process(&loaded, replace(event(), "synthetic", bad),
				  &target, &activity));
		EXPECT_TRUE(target.packets.empty());
	}
}

TEST(Core, TextLengthsCountWireUnitsAndRemainExplicit)
{
	std::string definition =
		schema(R"({"key":"length","number_of_bits":8},{"key":"value",)"
			R"("number_of_bits":32,"type":"text","text_encoding":"latin_1",)"
			R"("length_from":"length"})");
	std::string binding = "{\"cot\":\"uid\",\"vmf\":{\"key\":\"value\"}}";
	for (unsigned length : {2, 3}) {
		std::string extra = ",\"vmf_constants\":[{\"vmf\":{"
				    "\"key\":\"length\"},\"value\":" +
				    std::to_string(length) + "}]";
		owner loaded;

		ASSERT_EQ(CV_OK,
			  loaded.load(workspace(
				  definition,
				  output("text", mapping(binding, extra)))))
			<< loaded.error.message;
		sink target;
		cv_activity activity = {};
		cv_status status =
			process(&loaded, replace(event(), "synthetic", "éñ"),
				&target, &activity);

		if (length == 2) {
			ASSERT_EQ(CV_OK, status) << loaded.error.message;
			ASSERT_EQ(1u, target.packets.size());
			EXPECT_EQ("éñ",
				  decode(definition, target.packets[0]).text);
		} else {
			EXPECT_EQ(CV_OUTPUT_ERROR, status);
			EXPECT_TRUE(target.packets.empty());
		}
	}
}

TEST(Core, InactiveConstantsAndBindingsStillReceiveStaticValidation)
{
	std::string definition = schema(
		R"({"key":"mode","number_of_bits":8},{"key":"value",)"
			R"("number_of_bits":8,"constant":7,)"
			R"("when":{"all":[{"field":"mode","values":[{"first":1,)"
			R"("last":1}]}]}})");
	for (unsigned constant : {7, 8}) {
		std::string extra = ",\"vmf_constants\":[{\"vmf\":{"
				    "\"key\":\"mode\"},\"value\":0},{\"vmf\":{"
				    "\"key\":\"value\"},\"value\":" +
				    std::to_string(constant) + "}]";
		owner loaded;
		cv_status status = loaded.load(workspace(
			definition, output("conditional", mapping("", extra))));

		if (constant == 7) {
			ASSERT_EQ(CV_OK, status) << loaded.error.message;
			sink target;
			cv_activity activity = {};

			ASSERT_EQ(CV_OK, process(&loaded, event(), &target,
						 &activity));
			ASSERT_EQ(1u, target.packets.size());
			EXPECT_EQ((std::vector<uint64_t>{0}),
				  decode(definition, target.packets[0]).values);
		} else {
			EXPECT_EQ(CV_INVALID_CONFIG, status);
		}
	}
}

TEST(Core, RejectsOutOfRangeRepeatAndUnsupportedControlsAtLoad)
{
	std::string definition = schema(
		R"({"repeat":{"count":2,"body":{"key":"value",)"
		R"("number_of_bits":8}}})");
	std::string binding = "{\"cot\":\"point.latitude\","
			      "\"vmf\":{\"key\":\"value\"},"
			      "\"occurrences\":[{\"repeat\":1,\"index\":2}]}";
	owner bounds;

	EXPECT_EQ(CV_INVALID_CONFIG,
		  bounds.load(workspace(definition,
					output("bounds", mapping(binding)))));
	owner unsupported;

	EXPECT_EQ(CV_INVALID_CONFIG,
		  unsupported.load(workspace(
			  definition,
			  output("unsupported",
				 mapping("", ",\"repeat_counts\":[{\"repeat\":"
					     "1,\"count\":1}]")))));
}

TEST(Core, GeneratedDatagramCannotExceedUdpLimit)
{
	std::string definition =
		schema(R"({"key":"value","number_of_bits":524064,"type":"text",)"
			R"("text_encoding":"ascii_8"})");
	std::string extra = ",\"vmf_constants\":[{\"vmf\":{\"key\":\"value\"},"
			    "\"value\":\"" +
			    std::string(65508, 'A') + "\"}]";
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(definition,
					output("large", mapping("", extra)))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	EXPECT_EQ(CV_OUTPUT_ERROR,
		  process(&loaded, event(), &target, &activity));
	EXPECT_TRUE(activity.decoded);
	EXPECT_TRUE(target.packets.empty());
	EXPECT_EQ(1u, activity.outputs_failed);
	EXPECT_NE(nullptr, std::strstr(loaded.error.message, "UDP"));
}

TEST(Core, ImmutableWorkspaceSupportsIndependentConcurrentCalls)
{
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(
				 schema(field),
				 output("concurrent", mapping(latitude)))))
		<< loaded.error.message;
	std::vector<std::thread> threads;
	std::vector<sink> targets(8);
	std::vector<cv_activity> activities(8);
	std::vector<cv_status> statuses(8);
	std::string xml = event();

	for (size_t i = 0; i < targets.size(); ++i)
		threads.emplace_back([&, i]() {
			statuses[i] = cv_process(
				loaded.value,
				reinterpret_cast<const uint8_t *>(xml.data()),
				xml.size(), publish, &targets[i],
				&activities[i], nullptr);
		});
	for (auto &thread : threads)
		thread.join();
	for (size_t i = 0; i < targets.size(); ++i) {
		EXPECT_EQ(CV_OK, statuses[i]);
		EXPECT_EQ(1u, targets[i].packets.size());
		EXPECT_EQ(1u, activities[i].outputs_succeeded);
		if (targets[i].packets.size() == 1)
			EXPECT_EQ(targets[0].packets[0].bytes,
				  targets[i].packets[0].bytes);
	}
}

TEST(Core, SignedRepresentationsAndMinimumConstantRemainExact)
{
	for (const char *representation :
	     {"twos_complement", "ones_complement", "sign_magnitude"}) {
		std::string definition = schema(
			R"({"key":"value","number_of_bits":64,"type":")" +
			std::string(representation) + "\"}");
		owner loaded;

		ASSERT_EQ(CV_OK,
			  loaded.load(workspace(
				  definition,
				  output("signed",
					 mapping("{\"cot\":\"point.longitude\","
						 "\"vmf\":{\"key\":\"value\"}"
						 "}")))))
			<< loaded.error.message;
		sink target;
		cv_activity activity = {};

		ASSERT_EQ(CV_OK, process(&loaded,
					 replace(event(), "lon=\"-77\"",
						 "lon=\"-0.5\""),
					 &target, &activity))
			<< loaded.error.message;
		ASSERT_EQ(1u, target.packets.size());
		EXPECT_EQ((std::vector<uint64_t>{UINT64_MAX}),
			  decode(definition, target.packets[0]).values);
	}
	std::string definition =
		schema(R"({"key":"value","number_of_bits":64,"type":"twos_complement"})");
	owner loaded;

	ASSERT_EQ(CV_OK,
		  loaded.load(workspace(
			  definition,
			  output("minimum",
				 mapping("", ",\"vmf_constants\":[{\"vmf\":{"
					     "\"key\":\"value\"},\"value\":-"
					     "9223372036854775808}]")))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity));
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ((std::vector<uint64_t>{UINT64_C(1) << 63}),
		  decode(definition, target.packets[0]).values);
}

TEST(Core, SentinelCodesRequireExplicitLookupAndZeroScaleIsChecked)
{
	std::string definition =
		schema(R"({"key":"value","number_of_bits":8,)"
			R"("scale":{"factor":{"numerator":1,"denominator":1},)"
			R"("bias":{"numerator":0,"denominator":1},"sentinels":[38]}})");
	for (bool lookup : {false, true}) {
		std::string binding = latitude;

		if (lookup) {
			binding.pop_back();
			binding += ",\"values\":[{\"cot\":38,\"vmf\":38}]}";
		}
		owner loaded;

		ASSERT_EQ(CV_OK, loaded.load(workspace(
					 definition,
					 output("sentinel", mapping(binding)))))
			<< loaded.error.message;
		sink target;
		cv_activity activity = {};

		EXPECT_EQ(lookup ? CV_OK : CV_OUTPUT_ERROR,
			  process(&loaded, event(), &target, &activity));
		if (lookup) {
			ASSERT_EQ(1u, target.packets.size());
			EXPECT_EQ((std::vector<uint64_t>{38}),
				  decode(definition, target.packets[0]).values);
		} else {
			EXPECT_TRUE(target.packets.empty());
		}
	}
	owner zero;

	definition = replace(definition, "\"numerator\":1", "\"numerator\":0");
	EXPECT_EQ(CV_INVALID_CONFIG,
		  zero.load(workspace(definition,
				      output("zero", mapping(latitude)))));
}

TEST(Core, OnePortableDefinitionServesAllFourOutputProfiles)
{
	std::string definition = schema(field);
	std::string outputs;
	const vmf_envelope_version profiles[] = {VMF_ENVELOPE_B,
		VMF_ENVELOPE_C, VMF_ENVELOPE_D, VMF_ENVELOPE_D1};
	const char *names[] = {"B", "C", "D", "D1"};

	for (size_t i = 0; i < 4; ++i) {
		std::string config = replace(mapping(latitude),
			"\"envelope\":\"C\"", "\"envelope\":\"" +
			std::string(names[i]) + "\"");

		if (i)
			outputs += ",";
		outputs += output(names[i], config);
	}
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(definition, outputs)))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(4u, target.packets.size());
	EXPECT_EQ(4u, activity.outputs_succeeded);
	for (size_t i = 0; i < 4; ++i) {
		EXPECT_EQ(names[i], target.packets[i].id);
		ASSERT_FALSE(target.packets[i].bytes.empty());
		EXPECT_EQ(profiles[i], target.packets[i].bytes[0] & 0xf);
		auto decoded = decode(definition, target.packets[i], profiles[i]);

		EXPECT_EQ((std::vector<uint64_t>{38}), decoded.values);
		EXPECT_EQ(i != 0, decoded.identity.standard_version.present);
		if (i)
			EXPECT_EQ(i == 1 ? 8u : 7u,
				decoded.identity.standard_version.value);
	}
}

TEST(Core, MessageOrdinalsIsolateEditionsAndMaterializeSelectedDefaults)
{
	const std::string definition =
		R"({"format":"vmf-schema/1","message_standard":"TIDP-TE-R7",)"
			R"("messages":[{"message_number":"K01.1",)"
			R"("message_standard":"MIL-STD-6017B","elements":[)" +
		std::string(field) + R"(]},{"message_number":"K01.1",)"
			R"("message_standard":"MIL-STD-6017E","elements":[)" +
		replace(field, R"("number_of_bits":8)", R"("number_of_bits":16)") +
		"]}]}";
	std::string first = mapping(latitude);
	std::string d1 = replace(first, "\"envelope\":\"C\"",
		"\"envelope\":\"D1\"");
	std::string b0 = replace(first, "\"envelope\":\"C\"",
		"\"envelope\":\"B\"");
	std::string b1 = replace(b0, "\"message\":0", "\"message\":1");
	owner loaded;

	ASSERT_EQ(CV_OK, loaded.load(workspace(definition,
		output("c", first) + "," + output("d1", d1) + "," +
		output("b0", b0) + "," + output("b1", b1))))
		<< loaded.error.message;
	sink target;
	cv_activity activity = {};

	ASSERT_EQ(CV_OK, process(&loaded, event(), &target, &activity))
		<< loaded.error.message;
	ASSERT_EQ(4u, target.packets.size());
	EXPECT_EQ((std::vector<uint64_t>{38}),
		decode(definition, target.packets[0]).values);
	EXPECT_EQ((std::vector<uint64_t>{38}),
		decode(definition, target.packets[1], VMF_ENVELOPE_D1).values);
	EXPECT_EQ((std::vector<uint64_t>{38}),
		decode(definition, target.packets[2], VMF_ENVELOPE_B).values);
	EXPECT_EQ((std::vector<uint64_t>{38}),
		decode(definition, target.packets[3], VMF_ENVELOPE_B, 1).values);
	EXPECT_EQ(target.packets[2].bytes.size() + 1,
		target.packets[3].bytes.size());
	owner unsupported;

	EXPECT_EQ(CV_INVALID_CONFIG, unsupported.load(workspace(definition,
		output("unsupported", replace(first, "\"message\":0",
			"\"message\":1")))));
	EXPECT_NE(std::string::npos,
		std::string(unsupported.error.message).find("message 1"));
}

TEST(Core, OutputProfilesPreserveRawOriginsAndPermitNamedOverrides)
{
	const std::string raw = replace(schema(field),
		"\"message_standard\":\"MIL-STD-6017B\"",
		"\"envelope\":\"C\",\"standard_version\":8");
	std::string d1 = replace(mapping(latitude), "\"envelope\":\"C\"",
		"\"envelope\":\"D1\"");
	owner rejected;

	EXPECT_EQ(CV_INVALID_CONFIG,
		rejected.load(workspace(raw, output("raw", d1))));
	EXPECT_EQ(nullptr, rejected.value);
	const std::string named_override = replace(schema(field,
		",\"message_standard\":\"MIL-STD-6017B\""),
		"\"message_standard\":\"MIL-STD-6017B\"",
		"\"envelope\":\"C\",\"standard_version\":8");
	owner accepted;

	ASSERT_EQ(CV_OK, accepted.load(workspace(named_override,
		output("named", d1)))) << accepted.error.message;
	sink target;
	cv_activity activity = {};

	EXPECT_EQ(CV_OK, process(&accepted, event(), &target, &activity));
	ASSERT_EQ(1u, target.packets.size());
	EXPECT_EQ((std::vector<uint64_t>{38}),
		decode(named_override, target.packets[0], VMF_ENVELOPE_D1).values);
	owner absent;
	const std::string versionless = replace(schema(field),
		"\"message_standard\":\"MIL-STD-6017B\"",
		"\"standard_version\":\"absent\"");

	EXPECT_EQ(CV_INVALID_CONFIG,
		absent.load(workspace(versionless, output("absent", d1))));
}

TEST(Core, ExplicitMessageAndEnvelopeAreRequiredWithoutFallbacks)
{
	const std::string base = mapping(latitude);
	for (const std::string &config : {
		replace(base, "\"message\":0,", ""),
		replace(base, "\"envelope\":\"C\",", ""),
		replace(base, "\"message\":0", "\"message\":-1"),
		replace(base, "\"message\":0", "\"message\":1"),
		replace(base, "\"message\":0", "\"message\":0.0"),
		replace(base, "\"message\":0", "\"message\":\"0\""),
		replace(base, "\"message\":0", "\"message\":true"),
		replace(base, "\"message\":0", "\"message\":null"),
		replace(base, "\"message\":0",
			"\"message\":18446744073709551615"),
		replace(base, "\"envelope\":\"C\"", "\"envelope\":null"),
		replace(base, "\"envelope\":\"C\"", "\"envelope\":2"),
		replace(base, "\"envelope\":\"C\"", "\"envelope\":\"c\""),
		replace(base, "cot-vmf-mapping-config/1",
			"cot-vmf-mapping-config/999")}) {
		SCOPED_TRACE(config);
		owner loaded;

		EXPECT_EQ(CV_INVALID_CONFIG,
			loaded.load(workspace(schema(field),
				output("invalid", config))));
		EXPECT_EQ(nullptr, loaded.value);
	}
	owner unsupported;

	EXPECT_EQ(CV_INVALID_CONFIG, unsupported.load(replace(empty_workspace,
		"cot-vmf-workspace/1", "cot-vmf-workspace/999")));
}

TEST(Core, HeaderMetadataDefaultsOnlyOmittedContainers)
{
	for (const char *header : {"{}", "{\"fields\":{}}",
		"{\"fields\":{\"messages\":[{}]}}"}) {
		owner loaded;

		ASSERT_EQ(CV_OK, loaded.load(workspace(schema(field), output("ok",
			mapping(latitude, ",\"vmf_header\":" +
				std::string(header)))))) << loaded.error.message;
		sink target;
		cv_activity activity = {};

		EXPECT_EQ(CV_OK, process(&loaded, event(), &target, &activity));
		ASSERT_EQ(1u, target.packets.size());
		EXPECT_EQ((std::vector<uint64_t>{38}),
			decode(schema(field), target.packets[0]).values);
	}
	for (const char *header : {"null", "[]", "{\"fields\":null}",
		"{\"fields\":[]}", "{\"fields\":{\"messages\":null}}",
		"{\"fields\":{\"messages\":{}}}",
		"{\"fields\":{\"messages\":[]}}",
		"{\"fields\":{\"messages\":[null]}}",
		"{\"fields\":{\"messages\":[{},{}]}}",
		"{\"fields\":{\"messages\":[{\"id\":null}]}}",
		"{\"fields\":{\"messages\":[{\"id\":{}}]}}",
		"{\"fields\":{\"messages\":[{\"response\":{}}]}}"}) {
		SCOPED_TRACE(header);
		owner loaded;

		EXPECT_EQ(CV_INVALID_CONFIG, loaded.load(workspace(schema(field),
			output("bad", mapping(latitude,
				",\"vmf_header\":" + std::string(header))))));
		EXPECT_EQ(nullptr, loaded.value);
	}
}

TEST(Core, NestedGroupInferenceAndIndicatorRepeatCountsAreExplicit)
{
	std::string definition = schema(
		R"({"optional":{"recurrence":{"maximum":3,"body":[)"
		R"({"repeat":{"count":1,"body":{"key":"value",)"
		R"("number_of_bits":8}}}]}}})");
	std::string binding =
		"{\"cot\":\"point.latitude\","
		"\"vmf\":{\"key\":\"value\"},\"occurrences\":[{"
		"\"repeat\":1,\"index\":0},{\"repeat\":2,\"index\":0}]}";
	for (bool count : {false, true}) {
		std::string extra = count ? ",\"repeat_counts\":[{"
					    "\"repeat\":1,\"count\":1}]"
					  : "";
		owner loaded;

		ASSERT_EQ(CV_OK,
			  loaded.load(workspace(
				  definition,
				  output("nested", mapping(binding, extra)))))
			<< loaded.error.message;
		sink target;
		cv_activity activity = {};

		EXPECT_EQ(count ? CV_OK : CV_OUTPUT_ERROR,
			  process(&loaded, event(), &target, &activity));
		if (count) {
			ASSERT_EQ(1u, target.packets.size());
			EXPECT_EQ((std::vector<uint64_t>{38}),
				  decode(definition, target.packets[0]).values);
		} else {
			EXPECT_TRUE(target.packets.empty());
		}
	}
}

} /* namespace */
