// A minimal SQLite VFS for a canister, enabled by building SQLite with
// SQLITE_OS_OTHER=1.
//
// SQLite's own unix VFS needs file locks, mmap and getcwd, none of which exist
// in a canister. This VFS only uses open, pread, pwrite, ftruncate and fstat,
// which ic-wasi-polyfill maps onto files in stable memory.
//
// A canister runs one message at a time and a trap rolls back all its memory,
// so locks can be no-ops and sync has nothing to do.

#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "sqlite3.h"

typedef struct CanisterFile {
  sqlite3_file base;
  int fd;
} CanisterFile;

static int vfs_close(sqlite3_file *file) {
  CanisterFile *f = (CanisterFile *)file;
  return close(f->fd) == 0 ? SQLITE_OK : SQLITE_IOERR_CLOSE;
}

static int vfs_read(sqlite3_file *file, void *buf, int amount,
                    sqlite3_int64 offset) {
  CanisterFile *f = (CanisterFile *)file;
  char *out = (char *)buf;
  int done = 0;
  while (done < amount) {
    ssize_t n = pread(f->fd, out + done, (size_t)(amount - done),
                      (off_t)(offset + done));
    if (n < 0) return SQLITE_IOERR_READ;
    if (n == 0) break;
    done += (int)n;
  }
  if (done < amount) {
    // SQLite requires the unread tail to be zeroed on a short read
    memset(out + done, 0, (size_t)(amount - done));
    return SQLITE_IOERR_SHORT_READ;
  }
  return SQLITE_OK;
}

static int vfs_write(sqlite3_file *file, const void *buf, int amount,
                     sqlite3_int64 offset) {
  CanisterFile *f = (CanisterFile *)file;
  const char *in = (const char *)buf;
  int done = 0;
  while (done < amount) {
    ssize_t n = pwrite(f->fd, in + done, (size_t)(amount - done),
                       (off_t)(offset + done));
    if (n <= 0) return SQLITE_IOERR_WRITE;
    done += (int)n;
  }
  return SQLITE_OK;
}

static int vfs_truncate(sqlite3_file *file, sqlite3_int64 size) {
  CanisterFile *f = (CanisterFile *)file;
  return ftruncate(f->fd, (off_t)size) == 0 ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
}

static int vfs_sync(sqlite3_file *file, int flags) {
  (void)file;
  (void)flags;
  return SQLITE_OK;
}

static int vfs_file_size(sqlite3_file *file, sqlite3_int64 *size) {
  CanisterFile *f = (CanisterFile *)file;
  struct stat st;
  if (fstat(f->fd, &st) != 0) return SQLITE_IOERR_FSTAT;
  *size = (sqlite3_int64)st.st_size;
  return SQLITE_OK;
}

static int vfs_lock(sqlite3_file *file, int level) {
  (void)file;
  (void)level;
  return SQLITE_OK;
}

static int vfs_check_reserved(sqlite3_file *file, int *reserved) {
  (void)file;
  *reserved = 0;
  return SQLITE_OK;
}

static int vfs_file_control(sqlite3_file *file, int op, void *arg) {
  (void)file;
  (void)op;
  (void)arg;
  return SQLITE_NOTFOUND;
}

static int vfs_sector_size(sqlite3_file *file) {
  (void)file;
  return 4096;
}

static int vfs_device_characteristics(sqlite3_file *file) {
  (void)file;
  return SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_SAFE_APPEND |
         SQLITE_IOCAP_SEQUENTIAL | SQLITE_IOCAP_POWERSAFE_OVERWRITE;
}

static const sqlite3_io_methods canister_io_methods = {
    1,
    vfs_close,
    vfs_read,
    vfs_write,
    vfs_truncate,
    vfs_sync,
    vfs_file_size,
    vfs_lock,
    vfs_lock,
    vfs_check_reserved,
    vfs_file_control,
    vfs_sector_size,
    vfs_device_characteristics,
};

static int vfs_open(sqlite3_vfs *vfs, const char *path, sqlite3_file *file,
                    int flags, int *out_flags) {
  (void)vfs;
  CanisterFile *f = (CanisterFile *)file;
  f->base.pMethods = NULL;
  if (path == NULL) return SQLITE_CANTOPEN;

  int oflags = (flags & SQLITE_OPEN_READWRITE) ? O_RDWR : O_RDONLY;
  if (flags & SQLITE_OPEN_CREATE) oflags |= O_CREAT;
  if (flags & SQLITE_OPEN_EXCLUSIVE) oflags |= O_EXCL;

  f->fd = open(path, oflags, 0644);
  if (f->fd < 0) return SQLITE_CANTOPEN;

  if (out_flags) *out_flags = flags;
  f->base.pMethods = &canister_io_methods;
  return SQLITE_OK;
}

static int vfs_delete(sqlite3_vfs *vfs, const char *path, int sync_dir) {
  (void)vfs;
  (void)sync_dir;
  return unlink(path) == 0 ? SQLITE_OK : SQLITE_IOERR_DELETE_NOENT;
}

static int vfs_access(sqlite3_vfs *vfs, const char *path, int flags,
                      int *result) {
  (void)vfs;
  (void)flags;
  struct stat st;
  *result = stat(path, &st) == 0;
  return SQLITE_OK;
}

static int vfs_full_pathname(sqlite3_vfs *vfs, const char *path, int size,
                             char *out) {
  (void)vfs;
  sqlite3_snprintf(size, out, "%s", path);
  return SQLITE_OK;
}

// SQLite only uses this for temporary names and rowid collisions. A replicated
// canister must be deterministic, so it gets zeros and never a secret.
static int vfs_randomness(sqlite3_vfs *vfs, int size, char *out) {
  (void)vfs;
  memset(out, 0, (size_t)size);
  return size;
}

static int vfs_sleep(sqlite3_vfs *vfs, int microseconds) {
  (void)vfs;
  return microseconds;
}

static int vfs_current_time_int64(sqlite3_vfs *vfs, sqlite3_int64 *now) {
  (void)vfs;
  // Milliseconds since the Julian epoch, which is 2440587.5 days before 1970
  static const sqlite3_int64 unix_epoch_ms = 210866760000000;
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  *now = unix_epoch_ms + (sqlite3_int64)ts.tv_sec * 1000 +
         (sqlite3_int64)ts.tv_nsec / 1000000;
  return SQLITE_OK;
}

static int vfs_current_time(sqlite3_vfs *vfs, double *now) {
  sqlite3_int64 ms;
  vfs_current_time_int64(vfs, &ms);
  *now = (double)ms / 86400000.0;
  return SQLITE_OK;
}

static int vfs_get_last_error(sqlite3_vfs *vfs, int size, char *out) {
  (void)vfs;
  (void)size;
  (void)out;
  return 0;
}

int sqlite3_os_init(void) {
  static sqlite3_vfs vfs = {
      2,
      sizeof(CanisterFile),
      512,
      NULL,
      "canister",
      NULL,
      vfs_open,
      vfs_delete,
      vfs_access,
      vfs_full_pathname,
      NULL,
      NULL,
      NULL,
      NULL,
      vfs_randomness,
      vfs_sleep,
      vfs_current_time,
      vfs_get_last_error,
      vfs_current_time_int64,
  };
  return sqlite3_vfs_register(&vfs, 1);
}

int sqlite3_os_end(void) { return SQLITE_OK; }
