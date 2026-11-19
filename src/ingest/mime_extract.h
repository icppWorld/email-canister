// Reads what the mailbox needs from a raw RFC 5322 message, with libetpan.
// C, so that it builds with the rest of the vendored parser.

#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// All text is valid UTF-8 and owned by the summary
typedef struct MimeSummary {
  char *subject;
  char *sender;            // "Name <address>", or just the address
  char *sender_address;    // the address alone, as the From header has it
  char *text;              // the readable body, capped for the search index
  int64_t sent_at_seconds; // the Date header, 0 if absent or malformed
  uint32_t attachments;
} MimeSummary;

// Returns 0, or non-zero when the message cannot be parsed at all
int mime_extract(const char *data, size_t length, MimeSummary *out);
void mime_summary_free(MimeSummary *summary);

#ifdef __cplusplus
}
#endif
