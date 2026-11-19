#pragma once

#include <cstdint>

// More queue rows than this for one mailbox, and smtp_request asks senders to
// retry later the messages that include it
int64_t ingest_mailbox_cap();

// More messages waiting to be moved or parsed than this, and smtp_request asks
// every sender to retry later
int64_t ingest_backlog_cap();

// How long a delivery is recognized as a redelivery before it reaches the
// mailbox's file, which recognizes it from then on; and how long a sender's
// client_id is kept to the mailbox it was sent from
int64_t dedupe_window_ns();
