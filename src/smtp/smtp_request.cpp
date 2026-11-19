#include "smtp_request.h"

#include <algorithm>
#include <utility>

#include "candid_decoder.h"
#include "candid_type_graph.h"
#include "candid_value.h"

namespace {

// The Candid field hash
uint32_t id(const char *name) {
  uint32_t h = 0;
  for (; *name != '\0'; ++name) {
    h = h * 223 + static_cast<uint8_t>(*name);
  }
  return h;
}

int add_record(CandidTypeGraph &g, std::vector<CandidGraphField> fields) {
  std::sort(fields.begin(), fields.end(),
            [](const CandidGraphField &a, const CandidGraphField &b) {
              return a.id < b.id;
            });
  CandidGraphNode node;
  node.kind = CandidKind::Record;
  node.fields = std::move(fields);
  return g.add(std::move(node));
}

int add_wrapper(CandidTypeGraph &g, CandidKind kind, int inner) {
  CandidGraphNode node;
  node.kind = kind;
  node.inner = inner;
  return g.add(std::move(node));
}

int smtp_request_type(CandidTypeGraph &g) {
  const int text = CandidTypeGraph::prim(CandidKind::Text);
  const int nat8 = CandidTypeGraph::prim(CandidKind::Nat8);

  const int header = add_record(g, {{id("name"), text}, {id("value"), text}});
  const int message =
      add_record(g, {{id("headers"), add_wrapper(g, CandidKind::Vec, header)},
                     {id("body"), add_wrapper(g, CandidKind::Vec, nat8)}});
  const int address = add_record(g, {{id("user"), text}, {id("domain"), text}});
  const int envelope =
      add_record(g, {{id("from"), address},
                     {id("to"), add_wrapper(g, CandidKind::Vec, address)}});

  const int vec_text = add_wrapper(g, CandidKind::Vec, text);
  return add_record(
      g, {{id("message"), add_wrapper(g, CandidKind::Opt, message)},
          {id("envelope"), add_wrapper(g, CandidKind::Opt, envelope)},
          {id("gateway_flags"), add_wrapper(g, CandidKind::Opt, vec_text)},
          {id("message_id"), add_wrapper(g, CandidKind::Opt, text)}});
}

const CandidValue *opt_value(const CandidValue &record, const char *name) {
  const CandidValue *opt = record.field(id(name));
  if (opt == nullptr || opt->items.empty()) return nullptr;
  return &opt->items[0];
}

bool read_address(const CandidValue &v, SmtpAddress &out) {
  const CandidValue *user = v.field(id("user"));
  const CandidValue *domain = v.field(id("domain"));
  if (user == nullptr || domain == nullptr) return false;
  out.user = user->text;
  out.domain = domain->text;
  return true;
}

} // namespace

bool decode_smtp_request(const uint8_t *data, size_t size, SmtpRequest &out,
                         std::string &err) {
  CandidTypeGraph graph;
  const std::vector<int> args{smtp_request_type(graph)};
  std::vector<CandidValue> values;
  if (!CandidDecoder::decode(data, size, graph, args, values, err)) {
    return false;
  }
  const CandidValue &request = values[0];

  if (const CandidValue *envelope = opt_value(request, "envelope")) {
    const CandidValue *from = envelope->field(id("from"));
    const CandidValue *to = envelope->field(id("to"));
    if (from == nullptr || to == nullptr || !read_address(*from, out.from)) {
      err = "bad envelope";
      return false;
    }
    out.to.resize(to->vec_size());
    for (size_t i = 0; i < out.to.size(); ++i) {
      if (!read_address(to->at(i), out.to[i])) {
        err = "bad recipient";
        return false;
      }
    }
    out.has_envelope = true;
  }

  if (const CandidValue *message = opt_value(request, "message")) {
    const CandidValue *headers = message->field(id("headers"));
    const CandidValue *body = message->field(id("body"));
    if (headers == nullptr || body == nullptr) {
      err = "bad message";
      return false;
    }
    out.headers.resize(headers->vec_size());
    for (size_t i = 0; i < out.headers.size(); ++i) {
      const CandidValue *name = headers->at(i).field(id("name"));
      const CandidValue *value = headers->at(i).field(id("value"));
      if (name == nullptr || value == nullptr) {
        err = "bad header";
        return false;
      }
      out.headers[i].name = name->text;
      out.headers[i].value = value->text;
    }
    out.body = body->bytes;
    out.has_message = true;
  }

  if (const CandidValue *message_id = opt_value(request, "message_id")) {
    out.message_id = message_id->text;
    out.has_message_id = true;
  }
  return true;
}

bool decode_smtp_request(IC_API &ic_api, SmtpRequest &out, std::string &err) {
  const VecBytes bytes = ic_api.get_B_in();
  return decode_smtp_request(
      reinterpret_cast<const uint8_t *>(bytes.vec().data()), bytes.vec().size(),
      out, err);
}

void smtp_reply_ok(IC_API &ic_api) {
  ic_api.to_wire(CandidTypeVariant{"Ok", CandidTypeRecord{}});
}

void smtp_reply_err(IC_API &ic_api, uint64_t code, const std::string &message) {
  CandidTypeRecord error;
  error.append("code", CandidTypeNat64{code});
  error.append("message", CandidTypeText{message});
  ic_api.to_wire(CandidTypeVariant{"Err", error});
}
