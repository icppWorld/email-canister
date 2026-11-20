// The SQLite databases, on stable memory through src/store/sqlite_vfs.c:
// control.db, which holds the settings, the registry of mailboxes and the
// delivery queue, and one file per mailbox with its mail and outbox.
// Only db.cpp opens a database file (test/test_build_config.py).

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "sqlite3.h"

namespace db {

// Opens control.db, and creates it on a new canister. Traps on failure: only
// for canister_init and canister_post_upgrade.
void open();

// The registry, the queue and the settings. Every statement and transaction
// names the connection it runs on.
sqlite3 *control();

// Returns false on failure, so that the SMTP handlers never trap
bool exec(sqlite3 *db, const char *sql);

// The rows changed by the last statement on `db`
int64_t changes(sqlite3 *db);

// The rowid of the last row inserted on `db`
int64_t last_insert_id(sqlite3 *db);

// A transaction on one connection. It rolls back when it goes out of scope
// uncommitted, after the statements declared after it are finalized. A
// statement that is still stepping when it begins must end before commit().
class Transaction {
public:
  explicit Transaction(sqlite3 *db);
  ~Transaction();
  Transaction(const Transaction &) = delete;
  Transaction &operator=(const Transaction &) = delete;

  // True while it is open: false when BEGIN failed, and after a successful
  // commit()
  explicit operator bool() const { return m_db != nullptr; }

  bool commit(); // false when it failed: the transaction then rolls back

private:
  sqlite3 *m_db{nullptr};
};

// A prepared statement. Bound strings and blobs must outlive it.
class Stmt {
public:
  Stmt(sqlite3 *db, const char *sql);
  ~Stmt();
  Stmt(const Stmt &) = delete;
  Stmt &operator=(const Stmt &) = delete;

  explicit operator bool() const { return m_stmt != nullptr; }

  Stmt &text(int index, const std::string &value);
  Stmt &integer(int index, int64_t value);
  Stmt &blob(int index, const void *data, size_t size);

  void reset(); // to run the statement again, with new bindings

  bool row();  // steps, true when a row is available
  bool done(); // steps, true when the statement finished

  // Whether the last step failed. row() is false both when there is no more
  // row and when the step failed: after an error SQLite may have rolled the
  // transaction back itself, so a caller that goes on writing checks this.
  bool failed() const { return m_failed; }

  std::string column_text(int index);
  int64_t column_integer(int index);
  bool column_is_null(int index);
  const void *column_blob(int index);
  size_t column_bytes(int index);
  int column_count();
  std::string column_name(int index);

private:
  sqlite3_stmt *m_stmt{nullptr};
  bool m_failed{false};
};

// The mailbox files, at m/<id / 100>/<id>/mail.db, named only by the
// mailbox's id. Up to 32 stay open between calls; opening another closes the
// one used least recently, so a call works on one mailbox at a time.

// Creates the file with an empty mailbox, at the current schema version. Traps
// on failure.
sqlite3 *create_mailbox(int64_t id);

// The open file, or nullptr when the mailbox has none, it cannot be opened,
// or it is of another schema version than this code's, unless `any_version`,
// as for its upgrade or its check. Never creates one, and never traps. Every
// reader and writer of mail goes through the registry's mailbox_file().
sqlite3 *mailbox(int64_t id, bool any_version = false);

// The schema version of the mailbox files this code reads and writes
int64_t mailbox_version();

// The schema version of a database, or -1
int64_t file_version(sqlite3 *db);

// Takes a mailbox file from schema version `from` to the current one, in the
// caller's transaction. Returns false, with why in `error`, when a step fails.
bool upgrade_mailbox(sqlite3 *db, int64_t from, std::string &error);

// Closes the file, then shortens it by up to `step` bytes, and deletes it and
// its directory once it is empty. Returns the bytes left, or -1 on failure.
int64_t shrink_mailbox(int64_t id, int64_t step);

// The size of an open database, or -1 on failure
int64_t file_bytes(sqlite3 *db);

// The size of a mailbox's file on disk, or -1
int64_t mailbox_bytes(int64_t id);

// Reads up to `length` bytes of the file from `offset`, as they are on disk,
// for a download while nothing writes to it. Returns the file's size, or -1.
int64_t read_mailbox(int64_t id, int64_t offset, int64_t length,
                     std::vector<uint8_t> &out);

size_t open_mailboxes();

// SQLite's quick_check of one table, or of the whole database: up to 10
// problems. Traps when there is no such table.
std::vector<std::string> quick_check(sqlite3 *db,
                                     const std::optional<std::string> &table);

// A connection of its own to a mailbox's file, without FTS5, for a check of
// the whole file: quick_check then checks every b-tree, the search index's
// too, but not the index's contents, which FTS5 checks in full even in a
// quick_check, at three times the cost of the rest. A check of the table fts
// on the mailbox's own connection does that. That connection is closed
// meanwhile: one connection per file.
class CheckConnection {
public:
  explicit CheckConnection(int64_t id);
  ~CheckConnection();
  CheckConnection(const CheckConnection &) = delete;
  CheckConnection &operator=(const CheckConnection &) = delete;
  sqlite3 *get() const {
    return m_db;
  } // nullptr when the file cannot be opened

private:
  sqlite3 *m_db{nullptr};
};

#ifdef EMAIL_CANISTER_TEST_HOOKS
// Adds a step to the mailbox schema, which raises its version. Kept on the
// heap: an upgrade of the canister forgets it.
void add_schema_step(const std::string &sql);

// Runs SQL on a mailbox's file, around the registry, as a fault would, and
// closes it. Returns why it failed, or an empty string.
std::string exec_in_mailbox(int64_t id, const std::string &sql);

// Overwrites the type of the root page of `table` in the file, which SQLite's
// integrity check then reports
bool damage_mailbox(int64_t id, const std::string &table);

// Renames the file aside, or back, as if it could not be opened
bool hide_mailbox(int64_t id, bool hidden);

// Makes every statement whose SQL contains `sql` fail to prepare; an empty
// text ends it. Returns how many the fault in force had failed; the count
// starts again when the text changes.
int64_t fail_statements(const std::string &sql);
#endif

// All the stable memory the canister holds: the files and the file system's
// own overhead
int64_t stable_memory_bytes();

} // namespace db
