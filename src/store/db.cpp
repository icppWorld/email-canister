#include "db.h"

#include <algorithm>
#include <cerrno>
#include <fcntl.h>
#include <map>
#include <string_view>
#include <sys/stat.h>
#include <unistd.h>

#include "ic_api.h"

namespace {

sqlite3 *g_control = nullptr;

const int64_t k_control_cache_kib = 16384;
const int64_t k_mailbox_cache_kib = 1024;
const size_t k_open_mailboxes = 32;

// The registry and the work index: what the timers, the SMTP handlers and
// post_upgrade read without opening a mailbox file. Version 1 is the layout
// of the first release that has a control.db, so it needs no migration yet.
const char *const k_control_schema = R"sql(
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE mailboxes(
  id INTEGER PRIMARY KEY,
  local TEXT NOT NULL UNIQUE,
  vacant INTEGER NOT NULL DEFAULT 0, -- purged: the address is free, and there is no file
  disabled INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0, -- the file's mail and outbox, and the queue's
  message_count INTEGER NOT NULL DEFAULT 0,
  unseen INTEGER NOT NULL DEFAULT 0, -- unread messages in the Inbox
  uidvalidity INTEGER NOT NULL,
  next_uid INTEGER NOT NULL DEFAULT 1,
  modseq INTEGER NOT NULL DEFAULT 0,
  next_outbox_id INTEGER NOT NULL DEFAULT 1,
  file_bytes INTEGER NOT NULL DEFAULT 0,
  purging INTEGER NOT NULL DEFAULT 0, -- nothing opens the file meanwhile
  unparsed INTEGER NOT NULL DEFAULT 0, -- messages in the file waiting to be parsed
  quarantined INTEGER NOT NULL DEFAULT 0, -- messages in the file that cannot be parsed
  since_merge INTEGER NOT NULL DEFAULT 0,
  parse_id INTEGER NOT NULL DEFAULT 0, -- the message the parse attempts are for
  parse_attempts INTEGER NOT NULL DEFAULT 0,
  parse_error TEXT NOT NULL DEFAULT '', -- why the last attempt failed
  retry_after_ns INTEGER NOT NULL DEFAULT 0, -- no pump touches the file before; 0 once it opens
  outbox_due_ns INTEGER NOT NULL DEFAULT 0, -- 0 when nothing is waiting to be sent
  -- While the owner downloads the file, nothing writes to it until export_until_ns
  export_until_ns INTEGER NOT NULL DEFAULT 0,
  export_started_ns INTEGER NOT NULL DEFAULT 0, -- names the download, which a lapse ends
  export_principal TEXT NOT NULL DEFAULT '', -- who downloads: only they read and end it
  schema INTEGER NOT NULL DEFAULT 1, -- the file's schema version
  needs_repair TEXT NOT NULL DEFAULT '' -- why nothing may use the file; '' when fine
);
CREATE INDEX mailboxes_unparsed ON mailboxes(id) WHERE unparsed > 0;
CREATE INDEX mailboxes_outbox_due ON mailboxes(outbox_due_ns) WHERE outbox_due_ns > 0;
CREATE INDEX mailboxes_deferred ON mailboxes(retry_after_ns) WHERE retry_after_ns > 0;

-- Who may use a mailbox: every member reads, sends from and downloads it
CREATE TABLE members(
  mailbox_id INTEGER NOT NULL,
  principal TEXT NOT NULL,
  added_ns INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, principal)
) WITHOUT ROWID;
CREATE INDEX members_by_principal ON members(principal);

-- The names admins give principals, shown to the members of a mailbox
CREATE TABLE people(principal TEXT PRIMARY KEY, name TEXT NOT NULL);

-- A message is stored once for all its recipients on this domain
CREATE TABLE queue_bodies(
  id INTEGER PRIMARY KEY,
  raw BLOB NOT NULL,
  recipients INTEGER NOT NULL
);

CREATE TABLE queue(
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL,
  body_id INTEGER NOT NULL,
  envelope_from TEXT NOT NULL,
  rfc_message_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  received_ns INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(mailbox_id, envelope_from, dedupe_key)
);
CREATE INDEX queue_waiting ON queue(id) WHERE quarantined = 0;

-- What arrived recently, so that a redelivery is recognized after its move
CREATE TABLE dedupe(
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL,
  envelope_from TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  at_ns INTEGER NOT NULL,
  UNIQUE(mailbox_id, envelope_from, dedupe_key)
);
CREATE INDEX dedupe_by_time ON dedupe(at_ns);

-- What each principal sent recently, by client_id, whatever became of the
-- message or their membership since: a retry is answered with that message,
-- and refused from another of their mailboxes
CREATE TABLE sends(
  id INTEGER PRIMARY KEY,
  principal TEXT NOT NULL,
  client_id TEXT NOT NULL,
  mailbox_id INTEGER NOT NULL,
  outbox_id INTEGER NOT NULL,
  at_ns INTEGER NOT NULL,
  UNIQUE(principal, client_id)
);
CREATE INDEX sends_by_time ON sends(at_ns);
CREATE INDEX sends_by_message ON sends(mailbox_id, outbox_id);

PRAGMA user_version = 1;
)sql";

// A mailbox: its mail and outbox, and counters that copy the registry's, so
// that the file stands on its own
const char *const k_mailbox_schema = R"sql(
CREATE TABLE counters(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  message_count INTEGER NOT NULL,
  uidvalidity INTEGER NOT NULL,
  next_uid INTEGER NOT NULL,
  modseq INTEGER NOT NULL,
  next_outbox_id INTEGER NOT NULL,
  unseen INTEGER NOT NULL
);
INSERT INTO counters VALUES(1, 0, 0, 1, 0, 1, 0);

CREATE TABLE messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused in this file: parse_id names one
  uid INTEGER NOT NULL UNIQUE,
  state INTEGER NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,
  modseq INTEGER NOT NULL,
  received_ns INTEGER NOT NULL,
  envelope_from TEXT NOT NULL,
  rfc_message_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  format INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL DEFAULT 0,
  attachments INTEGER NOT NULL DEFAULT 0,
  preview TEXT NOT NULL DEFAULT '',
  UNIQUE(envelope_from, dedupe_key)
);
CREATE INDEX messages_unparsed ON messages(id) WHERE state = 0;

-- Which members opened a message, and when
CREATE TABLE seen_by(
  uid INTEGER NOT NULL,
  principal TEXT NOT NULL,
  at_ns INTEGER NOT NULL,
  PRIMARY KEY (uid, principal)
) WITHOUT ROWID;

CREATE TABLE bodies(id INTEGER PRIMARY KEY, raw BLOB NOT NULL);

CREATE VIRTUAL TABLE fts USING
  fts5(subject, sender, body, content='', contentless_delete=1);
INSERT INTO fts(fts, rank) VALUES('automerge', 0);
INSERT INTO fts(fts, rank) VALUES('crisismerge', 64);

CREATE TABLE outbox(
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL, -- the sender's: theirs alone
  sent_by TEXT NOT NULL, -- the member who sent it
  key_prefix TEXT NOT NULL, -- the bridge key without the generation
  state INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_ns INTEGER NOT NULL,
  first_attempt_ns INTEGER NOT NULL DEFAULT 0,
  next_attempt_ns INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  recipients_to TEXT NOT NULL,
  recipients_cc TEXT NOT NULL,
  recipients_bcc TEXT NOT NULL,
  subject TEXT NOT NULL,
  attachments INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  UNIQUE(sent_by, client_id)
);
CREATE INDEX outbox_due ON outbox(next_attempt_ns) WHERE state IN (0, 1);

CREATE TABLE outbox_bodies(id INTEGER PRIMARY KEY, html TEXT NOT NULL);

CREATE TABLE outbox_attachments(
  id INTEGER PRIMARY KEY,
  outbox_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content BLOB NOT NULL
);
CREATE INDEX outbox_attachments_by_message ON outbox_attachments(outbox_id);

PRAGMA user_version = 1;
)sql";

// The changes to a mailbox file after version 1: step i takes a file from
// version i + 1 to i + 2. The test build adds some.
std::vector<std::string> g_steps = {
    // Version 2: the Trash and Spam folders, and the senders blocked. Every
    // message is in the Inbox, so the counters stay as they are; the index
    // holds only the mail out of it, and the messages table is small.
    R"sql(
ALTER TABLE messages ADD COLUMN folder INTEGER NOT NULL DEFAULT 0; -- 0 Inbox, 1 Trash, 2 Spam
ALTER TABLE messages ADD COLUMN folder_ns INTEGER NOT NULL DEFAULT 0; -- when it left the Inbox
CREATE INDEX messages_filed ON messages(folder, uid) WHERE folder != 0;
CREATE INDEX messages_expiring ON messages(folder_ns) WHERE folder != 0;

-- Mail from these addresses goes to Spam
CREATE TABLE blocked(
  address TEXT PRIMARY KEY, -- in lower case
  blocked_by TEXT NOT NULL,
  at_ns INTEGER NOT NULL
) WITHOUT ROWID;
)sql",
    // Version 3: each message's From address, so the list can block its
    // sender. A new column only, so no row is rewritten: mail parsed before
    // has the address in its sender text, where the list reads it.
    R"sql(
ALTER TABLE messages ADD COLUMN sender_address TEXT NOT NULL DEFAULT ''; -- set by the parse
)sql",
};

struct OpenMailbox {
  sqlite3 *db;
  uint64_t used;   // when it was last asked for
  int64_t version; // its schema version, when it was last read
};

// The heap survives between calls but not an upgrade
std::map<int64_t, OpenMailbox> g_mailboxes;
uint64_t g_uses = 0;

void exec_or_trap(sqlite3 *db, const char *sql) {
  if (!db::exec(db, sql)) {
    IC_API::trap(std::string(sql) + ": " + sqlite3_errmsg(db));
  }
}

// Opens a database file with the settings every connection uses, and a page
// cache of `cache_kib`. Returns nullptr on failure, with its cause in `error`.
sqlite3 *open_file(const std::string &path, int64_t cache_kib, bool create,
                   std::string &error) {
  sqlite3 *db = nullptr;
  const int flags = SQLITE_OPEN_READWRITE | (create ? SQLITE_OPEN_CREATE : 0);
  const std::string cache = "PRAGMA cache_size=-" + std::to_string(cache_kib);
  bool ok = sqlite3_open_v2(path.c_str(), &db, flags, nullptr) == SQLITE_OK;
  for (const char *sql :
       {"PRAGMA page_size=4096", "PRAGMA locking_mode=EXCLUSIVE",
        "PRAGMA journal_mode=MEMORY", "PRAGMA synchronous=OFF",
        "PRAGMA temp_store=MEMORY", cache.c_str()}) {
    ok = ok && db::exec(db, sql);
  }
  if (ok) return db;
  error = "cannot open " + path + ": " + sqlite3_errmsg(db);
  sqlite3_close_v2(db);
  return nullptr;
}

sqlite3 *open_or_trap(const std::string &path, int64_t cache_kib) {
  std::string error;
  sqlite3 *db = open_file(path, cache_kib, true, error);
  if (db == nullptr) IC_API::trap(error);
  return db;
}

int64_t user_version(sqlite3 *db) {
  const int64_t version = db::file_version(db);
  if (version < 0) IC_API::trap("cannot read the schema version");
  return version;
}

bool exists(const std::string &path) {
  struct stat st;
  return stat(path.c_str(), &st) == 0;
}

void make_dir(const std::string &dir) {
  if (mkdir(dir.c_str(), 0700) != 0 && errno != EEXIST) {
    IC_API::trap("cannot create the directory " + dir);
  }
}

// stable-fs looks a missing name up by scanning its whole directory, and
// SQLite looks for a journal on every open, so no directory may grow large
std::string bucket_of(int64_t id) { return "m/" + std::to_string(id / 100); }
std::string dir_of(int64_t id) {
  return bucket_of(id) + "/" + std::to_string(id);
}
std::string file_of(int64_t id) { return dir_of(id) + "/mail.db"; }

// Makes room for one more open file
void make_room() {
  if (g_mailboxes.size() < k_open_mailboxes) return;
  auto oldest = g_mailboxes.begin();
  for (auto it = g_mailboxes.begin(); it != g_mailboxes.end(); ++it) {
    if (it->second.used < oldest->second.used) oldest = it;
  }
  sqlite3_close_v2(oldest->second.db);
  g_mailboxes.erase(oldest);
}

sqlite3 *remember(int64_t id, sqlite3 *db, int64_t version) {
  g_mailboxes[id] = OpenMailbox{db, ++g_uses, version};
  return db;
}

void close_mailbox(int64_t id) {
  auto found = g_mailboxes.find(id);
  if (found == g_mailboxes.end()) return;
  sqlite3_close_v2(found->second.db);
  g_mailboxes.erase(found);
}

} // namespace

namespace db {

void open() {
  if (exists("mail.db")) {
    IC_API::trap("this canister holds a v0.1.x mail.db, which v0.2.0 cannot "
                 "upgrade: reinstall it, which erases its mail");
  }
  g_control = open_or_trap("control.db", k_control_cache_kib);
  const int64_t schema = user_version(g_control);
  if (schema > 1) IC_API::trap("control.db is from a newer release");
  if (schema == 0) {
    exec_or_trap(g_control, k_control_schema);
    // Outbox keys stay unique at the bridge even if this canister is reinstalled
    Stmt prefix(g_control, "INSERT INTO settings VALUES('outbox_prefix', ?)");
    const std::string now = std::to_string(IC_API::time());
    if (!prefix || !prefix.text(1, now).done()) {
      IC_API::trap("cannot store the outbox prefix");
    }
  }
  make_dir("m");
}

sqlite3 *control() { return g_control; }

bool exec(sqlite3 *db, const char *sql) {
  return sqlite3_exec(db, sql, nullptr, nullptr, nullptr) == SQLITE_OK;
}

int64_t changes(sqlite3 *db) { return sqlite3_changes(db); }

int64_t last_insert_id(sqlite3 *db) { return sqlite3_last_insert_rowid(db); }

Transaction::Transaction(sqlite3 *db) {
  if (db != nullptr && exec(db, "BEGIN")) m_db = db;
}

Transaction::~Transaction() {
  if (m_db != nullptr) exec(m_db, "ROLLBACK");
}

bool Transaction::commit() {
  if (m_db == nullptr || !exec(m_db, "COMMIT")) return false;
  m_db = nullptr;
  return true;
}

#ifdef EMAIL_CANISTER_TEST_HOOKS
namespace {
std::string g_failing_sql;
int64_t g_failed_statements = 0;
} // namespace
int64_t fail_statements(const std::string &sql) {
  const int64_t failed = g_failed_statements;
  if (sql != g_failing_sql) g_failed_statements = 0;
  g_failing_sql = sql;
  return failed;
}
#endif

Stmt::Stmt(sqlite3 *db, const char *sql) {
#ifdef EMAIL_CANISTER_TEST_HOOKS
  if (!g_failing_sql.empty() &&
      std::string_view(sql).find(g_failing_sql) != std::string_view::npos) {
    ++g_failed_statements;
    return;
  }
#endif
  if (db == nullptr ||
      sqlite3_prepare_v2(db, sql, -1, &m_stmt, nullptr) != SQLITE_OK) {
    m_stmt = nullptr;
  }
}

Stmt::~Stmt() { sqlite3_finalize(m_stmt); }

Stmt &Stmt::text(int index, const std::string &value) {
  sqlite3_bind_text(m_stmt, index, value.data(), static_cast<int>(value.size()),
                    SQLITE_STATIC);
  return *this;
}

Stmt &Stmt::integer(int index, int64_t value) {
  sqlite3_bind_int64(m_stmt, index, value);
  return *this;
}

Stmt &Stmt::blob(int index, const void *data, size_t size) {
  sqlite3_bind_blob(m_stmt, index, data, static_cast<int>(size), SQLITE_STATIC);
  return *this;
}

void Stmt::reset() {
  sqlite3_reset(m_stmt);
  sqlite3_clear_bindings(m_stmt);
  m_failed = false;
}

bool Stmt::row() {
  const int result = sqlite3_step(m_stmt);
  m_failed = result != SQLITE_ROW && result != SQLITE_DONE;
  return result == SQLITE_ROW;
}

bool Stmt::done() {
  const int result = sqlite3_step(m_stmt);
  m_failed = result != SQLITE_ROW && result != SQLITE_DONE;
  return result == SQLITE_DONE;
}

std::string Stmt::column_text(int index) {
  const unsigned char *s = sqlite3_column_text(m_stmt, index);
  return s == nullptr ? std::string()
                      : std::string(reinterpret_cast<const char *>(s),
                                    sqlite3_column_bytes(m_stmt, index));
}

int64_t Stmt::column_integer(int index) {
  return sqlite3_column_int64(m_stmt, index);
}

int Stmt::column_count() { return sqlite3_column_count(m_stmt); }

std::string Stmt::column_name(int index) {
  const char *name = sqlite3_column_name(m_stmt, index);
  return name != nullptr ? name : "";
}

bool Stmt::column_is_null(int index) {
  return sqlite3_column_type(m_stmt, index) == SQLITE_NULL;
}

const void *Stmt::column_blob(int index) {
  return sqlite3_column_blob(m_stmt, index);
}

size_t Stmt::column_bytes(int index) {
  return static_cast<size_t>(sqlite3_column_bytes(m_stmt, index));
}

sqlite3 *create_mailbox(int64_t id) {
  if (exists(file_of(id))) IC_API::trap("the mailbox already has a file");
  make_dir(bucket_of(id));
  make_dir(dir_of(id));
  make_room();
  sqlite3 *db = open_or_trap(file_of(id), k_mailbox_cache_kib);
  exec_or_trap(db, k_mailbox_schema);
  std::string error;
  if (!upgrade_mailbox(db, 1, error)) IC_API::trap(error);
  return remember(id, db, mailbox_version());
}

sqlite3 *mailbox(int64_t id, bool any_version) {
  auto found = g_mailboxes.find(id);
  if (found != g_mailboxes.end()) {
    OpenMailbox &open = found->second;
    open.used = ++g_uses;
    // An upgrade changes the version of an open file: read it again
    if (!any_version && open.version != mailbox_version())
      open.version = file_version(open.db);
    return any_version || open.version == mailbox_version() ? open.db : nullptr;
  }
  if (!exists(file_of(id))) return nullptr;
  std::string error;
  sqlite3 *db = open_file(file_of(id), k_mailbox_cache_kib, false, error);
  if (db == nullptr) return nullptr;
  const int64_t version = file_version(db);
  if (version < 1) { // no mailbox
    sqlite3_close_v2(db);
    return nullptr;
  }
  make_room(); // only for a file that opened
  remember(id, db, version);
  return any_version || version == mailbox_version() ? db : nullptr;
}

int64_t shrink_mailbox(int64_t id, int64_t step) {
  close_mailbox(id);
  const std::string file = file_of(id);
  struct stat st;
  if (stat(file.c_str(), &st) != 0) {
    if (errno != ENOENT) return -1;
  } else {
    const int64_t size = static_cast<int64_t>(st.st_size);
    if (size > step) {
      return truncate(file.c_str(), size - step) == 0 ? size - step : -1;
    }
    if (unlink(file.c_str()) != 0) return -1;
  }
  // The bucket stays: other mailboxes share it
  if (rmdir(dir_of(id).c_str()) != 0 && errno != ENOENT) return -1;
  return 0;
}

size_t open_mailboxes() { return g_mailboxes.size(); }

int64_t mailbox_version() { return 1 + static_cast<int64_t>(g_steps.size()); }

int64_t file_version(sqlite3 *db) {
  Stmt version(db, "PRAGMA user_version");
  return version && version.row() ? version.column_integer(0) : -1;
}

bool upgrade_mailbox(sqlite3 *db, int64_t from, std::string &error) {
  if (from == mailbox_version()) return true;
  for (int64_t version = from; version < mailbox_version(); ++version) {
    if (!exec(db, g_steps[static_cast<size_t>(version - 1)].c_str())) {
      error = "the step to schema version " + std::to_string(version + 1) +
              " failed: " + sqlite3_errmsg(db);
      return false;
    }
  }
  const std::string set =
      "PRAGMA user_version = " + std::to_string(mailbox_version());
  if (exec(db, set.c_str())) return true;
  error = std::string("cannot set the schema version: ") + sqlite3_errmsg(db);
  return false;
}

std::vector<std::string> quick_check(sqlite3 *db,
                                     const std::optional<std::string> &table) {
  if (table) {
    Stmt known(db, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND "
                   "name = ?");
    if (!known || !known.text(1, *table).row())
      IC_API::trap("the file has no table " + *table);
  }
  Stmt check(db, table ? "SELECT * FROM pragma_quick_check(?)"
                       : "SELECT * FROM pragma_quick_check");
  if (check && table) check.text(1, *table);
  std::vector<std::string> problems;
  for (int rows = 0; check && rows < 10 && check.row(); ++rows) {
    if (check.column_text(0) != "ok") problems.push_back(check.column_text(0));
  }
  if (!check || check.failed()) problems.push_back(sqlite3_errmsg(db));
  return problems;
}

CheckConnection::CheckConnection(int64_t id) {
  close_mailbox(id);
  std::string error;
  if (exists(file_of(id)))
    m_db = open_file(file_of(id), k_mailbox_cache_kib, false, error);
  if (m_db != nullptr) sqlite3_drop_modules(m_db, nullptr);
}

CheckConnection::~CheckConnection() { sqlite3_close_v2(m_db); }

#ifdef EMAIL_CANISTER_TEST_HOOKS
void add_schema_step(const std::string &sql) { g_steps.push_back(sql); }

std::string exec_in_mailbox(int64_t id, const std::string &sql) {
  sqlite3 *db = mailbox(id, true);
  if (db == nullptr) return "the file cannot be opened";
  const std::string error =
      exec(db, sql.c_str())
          ? ""
          : std::string("the SQL failed: ") + sqlite3_errmsg(db);
  close_mailbox(id); // its next use reads its version afresh
  return error;
}

bool damage_mailbox(int64_t id, const std::string &table) {
  int64_t root = 0;
  {
    sqlite3 *db = mailbox(id, true);
    Stmt select(db, "SELECT rootpage FROM sqlite_schema WHERE name = ?");
    if (!select || !select.text(1, table).row()) return false;
    root = select.column_integer(0);
  }
  close_mailbox(id);
  // 0 is no valid b-tree page type. Page 1 starts after the file header.
  const off_t at =
      static_cast<off_t>((root - 1) * 4096 + (root == 1 ? 100 : 0));
  const int fd = ::open(file_of(id).c_str(), O_WRONLY);
  if (fd < 0) return false;
  const uint8_t zero = 0;
  const bool written = pwrite(fd, &zero, 1, at) == 1;
  close(fd);
  return written;
}

bool hide_mailbox(int64_t id, bool hidden) {
  close_mailbox(id);
  const std::string file = file_of(id);
  const std::string aside = file + ".hidden";
  return hidden ? rename(file.c_str(), aside.c_str()) == 0
                : rename(aside.c_str(), file.c_str()) == 0;
}
#endif

int64_t stable_memory_bytes() {
  return static_cast<int64_t>(IC_API::get_stable_size() * 65536);
}

int64_t mailbox_bytes(int64_t id) {
  struct stat st;
  return stat(file_of(id).c_str(), &st) == 0 ? static_cast<int64_t>(st.st_size)
                                             : -1;
}

int64_t read_mailbox(int64_t id, int64_t offset, int64_t length,
                     std::vector<uint8_t> &out) {
  out.clear();
  const int fd = ::open(file_of(id).c_str(), O_RDONLY);
  if (fd < 0) return -1;
  struct stat st;
  int64_t size = fstat(fd, &st) == 0 ? static_cast<int64_t>(st.st_size) : -1;
  if (size >= 0 && offset < size) {
    out.resize(static_cast<size_t>(std::min(length, size - offset)));
    size_t got = 0;
    while (got < out.size()) {
      const ssize_t n =
          pread(fd, out.data() + got, out.size() - got,
                static_cast<off_t>(offset) + static_cast<off_t>(got));
      if (n <= 0) break;
      got += static_cast<size_t>(n);
    }
    if (got != out.size()) size = -1;
  }
  close(fd);
  return size;
}

int64_t file_bytes(sqlite3 *db) {
  Stmt size(
      db,
      "SELECT page_count * page_size FROM pragma_page_count, pragma_page_size");
  return size && size.row() ? size.column_integer(0) : -1;
}

} // namespace db
