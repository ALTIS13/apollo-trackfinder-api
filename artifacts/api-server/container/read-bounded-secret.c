#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(void) {
  static const char message[] = "TF secret read failed\n";
  const ssize_t ignored = write(STDERR_FILENO, message, sizeof(message) - 1);
  (void)ignored;
  return 1;
}

static bool same_file(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev &&
         left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode &&
         left->st_size == right->st_size &&
         left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
         left->st_mtim.tv_nsec == right->st_mtim.tv_nsec &&
         left->st_ctim.tv_sec == right->st_ctim.tv_sec &&
         left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}

static bool write_all(int descriptor, const unsigned char *buffer, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    const ssize_t written = write(descriptor, buffer + offset, size - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return false;
    offset += (size_t)written;
  }
  return true;
}

int main(int argc, char **argv) {
  bool append_sentinel = false;
  const char *path = NULL;
  const char *maximum_text = NULL;

  if (argc == 4 && strcmp(argv[1], "--append-sentinel") == 0) {
    append_sentinel = true;
    path = argv[2];
    maximum_text = argv[3];
  } else if (argc == 3) {
    path = argv[1];
    maximum_text = argv[2];
  } else {
    return fail();
  }

  errno = 0;
  char *end = NULL;
  const unsigned long parsed = strtoul(maximum_text, &end, 10);
  if (errno != 0 || end == maximum_text || *end != '\0' ||
      parsed == 0 || parsed > 4096) {
    return fail();
  }
  const size_t maximum = (size_t)parsed;

  const int descriptor =
      open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (descriptor < 0) return fail();

  struct stat before;
  struct stat after;
  struct stat path_after;
  unsigned char *buffer = NULL;
  int result = 1;

  if (fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode)) goto cleanup;
  buffer = malloc(maximum + 1);
  if (buffer == NULL) goto cleanup;

  size_t total = 0;
  while (total < maximum + 1) {
    const ssize_t loaded = read(descriptor, buffer + total, maximum + 1 - total);
    if (loaded < 0 && errno == EINTR) continue;
    if (loaded < 0) goto cleanup;
    if (loaded == 0) break;
    total += (size_t)loaded;
  }

  if (fstat(descriptor, &after) != 0 ||
      fstatat(AT_FDCWD, path, &path_after, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(path_after.st_mode) ||
      !same_file(&before, &after) ||
      !same_file(&after, &path_after) ||
      before.st_size < 1 ||
      (uintmax_t)before.st_size > maximum ||
      total != (size_t)before.st_size ||
      total < 1 ||
      total > maximum ||
      memchr(buffer, '\0', total) != NULL) {
    goto cleanup;
  }

  if (!write_all(STDOUT_FILENO, buffer, total)) goto cleanup;
  if (append_sentinel) {
    static const unsigned char sentinel = 0x1e;
    if (!write_all(STDOUT_FILENO, &sentinel, 1)) goto cleanup;
  }
  result = 0;

cleanup:
  if (buffer != NULL) {
    memset(buffer, 0, maximum + 1);
    free(buffer);
  }
  (void)close(descriptor);
  if (result != 0) return fail();
  return 0;
}
