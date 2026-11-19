// The DFINITY SMTP Gateway Protocol: decoding a request and replying.
//
// A trap in these handlers makes a sending server retry for days, so a request
// is decoded with CandidDecoder, which reports a bad message instead of
// trapping the way ic_api.from_wire() does.
//
// https://github.com/dfinity/ic-smtp-gateway-protocol

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "ic_api.h"

struct SmtpAddress {
  std::string user;
  std::string domain;
};

struct SmtpHeader {
  std::string name;
  std::string value;
};

// Every field of the protocol's SmtpRequest is opt, so each has a flag
struct SmtpRequest {
  bool has_envelope{false};
  SmtpAddress from;
  std::vector<SmtpAddress> to;

  bool has_message{false};
  std::vector<SmtpHeader> headers;
  std::vector<uint8_t> body;

  bool has_message_id{false};
  std::string message_id;
};

// Returns false, with a reason in err, for bytes that are not an SmtpRequest
bool decode_smtp_request(const uint8_t *data, size_t size, SmtpRequest &out,
                         std::string &err);

// Decodes the argument of the current message
bool decode_smtp_request(IC_API &ic_api, SmtpRequest &out, std::string &err);

void smtp_reply_ok(IC_API &ic_api);

// Keep message short, single-line ASCII: the gateway copies it into the SMTP
// reply line. Code 500-599 bounces; anything else makes the sender retry.
void smtp_reply_err(IC_API &ic_api, uint64_t code, const std::string &message);
