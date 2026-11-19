// Replaces libetpan's charconv.c, which needs iconv or ICU.
//
// Every conversion produces valid UTF-8: a byte sequence that does not decode
// becomes U+FFFD. An unsupported source charset reports
// MAIL_CHARCONV_ERROR_UNKNOWN_CHARSET, and libetpan then falls back to reading
// the bytes as ISO-8859-1. The tables come from tools/gen_charsets.py.

#include "charconv.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "charset_tables.h"

int (*extended_charconv)(const char *tocode, const char *fromcode,
                         const char *str, size_t length, char *result,
                         size_t *result_len) = NULL;

#define REPLACEMENT 0xFFFD

enum kind {
  KIND_UTF8,
  KIND_SINGLE_BYTE,
  KIND_SHIFT_JIS,
  KIND_EUC_JP,
  KIND_ISO_2022_JP,
  KIND_GB18030,
  KIND_CP950,
  KIND_CP949
};

struct source {
  enum kind kind;
  const unsigned short *high; // KIND_SINGLE_BYTE only
};

static const struct {
  const char *name;
  enum kind kind;
} multi_byte_names[] = {
    {"utf8", KIND_UTF8},
    {"usascii", KIND_UTF8},
    {"ascii", KIND_UTF8},
    {"iso646us", KIND_UTF8},
    {"iso2022jp", KIND_ISO_2022_JP},
    {"shiftjis", KIND_SHIFT_JIS},
    {"sjis", KIND_SHIFT_JIS},
    {"xsjis", KIND_SHIFT_JIS},
    {"mskanji", KIND_SHIFT_JIS},
    {"windows31j", KIND_SHIFT_JIS},
    {"cp932", KIND_SHIFT_JIS},
    {"eucjp", KIND_EUC_JP},
    {"xeucjp", KIND_EUC_JP},
    {"gb2312", KIND_GB18030},
    {"gbk", KIND_GB18030},
    {"cp936", KIND_GB18030},
    {"gb18030", KIND_GB18030},
    {"big5", KIND_CP950},
    {"big5hkscs", KIND_CP950},
    {"cp950", KIND_CP950},
    {"euckr", KIND_CP949},
    {"ksc5601", KIND_CP949},
    {"ksc56011987", KIND_CP949},
    {"korean", KIND_CP949},
    {"cp949", KIND_CP949},
    {"windows949", KIND_CP949},
    {"xwindows949", KIND_CP949},
    {"uhc", KIND_CP949},
};

// Lower-cases and drops punctuation, so "ISO_8859-2" matches "iso88592"
static int normalize(const char *name, char *out, size_t size) {
  size_t n = 0;
  for (; *name != '\0'; ++name) {
    if (!isalnum((unsigned char)*name)) continue;
    if (n + 1 >= size) return 0;
    out[n++] = (char)tolower((unsigned char)*name);
  }
  out[n] = '\0';
  return 1;
}

static int source_of(const char *fromcode, struct source *out) {
  char name[32];
  if (!normalize(fromcode, name, sizeof name)) return 0;
  for (size_t i = 0; i < sizeof multi_byte_names / sizeof multi_byte_names[0];
       ++i) {
    if (strcmp(name, multi_byte_names[i].name) == 0) {
      out->kind = multi_byte_names[i].kind;
      out->high = NULL;
      return 1;
    }
  }
  const char *resolved = name;
  for (unsigned int i = 0; i < charset_alias_count; ++i) {
    if (strcmp(name, charset_aliases[i].alias) == 0) {
      resolved = charset_aliases[i].name;
      break;
    }
  }
  for (unsigned int i = 0; i < single_byte_charset_count; ++i) {
    if (strcmp(resolved, single_byte_charsets[i].name) == 0) {
      out->kind = KIND_SINGLE_BYTE;
      out->high = single_byte_charsets[i].high;
      return 1;
    }
  }
  return 0;
}

static size_t put_utf8(char *out, unsigned int cp) {
  if (cp < 0x80) {
    out[0] = (char)cp;
    return 1;
  }
  if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
  }
  out[0] = (char)(0xF0 | (cp >> 18));
  out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
  out[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

static unsigned int mapped(unsigned short value) {
  return value != 0 ? value : REPLACEMENT;
}

// Each decoder reads one character and returns how many bytes it used.

static size_t decode_utf8(const unsigned char *s, size_t left,
                          unsigned int *cp) {
  unsigned char c = s[0];
  size_t length;
  unsigned int value, minimum;
  if (c < 0x80) {
    *cp = c;
    return 1;
  }
  if (c >= 0xC2 && c <= 0xDF) {
    length = 2, value = c & 0x1F, minimum = 0x80;
  } else if (c >= 0xE0 && c <= 0xEF) {
    length = 3, value = c & 0x0F, minimum = 0x800;
  } else if (c >= 0xF0 && c <= 0xF4) {
    length = 4, value = c & 0x07, minimum = 0x10000;
  } else {
    *cp = REPLACEMENT;
    return 1;
  }
  if (left < length) {
    *cp = REPLACEMENT;
    return 1;
  }
  for (size_t i = 1; i < length; ++i) {
    if ((s[i] & 0xC0) != 0x80) {
      *cp = REPLACEMENT;
      return 1;
    }
    value = (value << 6) | (s[i] & 0x3F);
  }
  if (value < minimum || value > 0x10FFFF ||
      (value >= 0xD800 && value <= 0xDFFF)) {
    *cp = REPLACEMENT;
    return 1;
  }
  *cp = value;
  return length;
}

static size_t decode_double_byte(const unsigned short *table,
                                 const unsigned char *s, size_t left,
                                 unsigned int *cp) {
  unsigned char lead = s[0];
  if (lead < 0x80) {
    *cp = lead;
    return 1;
  }
  if (lead == 0x80 || lead == 0xFF || left < 2 || s[1] < 0x40 || s[1] == 0xFF) {
    *cp = REPLACEMENT;
    return 1;
  }
  *cp = mapped(table[(lead - 0x81) * DOUBLE_BYTE_TRAILS + (s[1] - 0x40)]);
  return 2;
}

static unsigned int gb18030_bmp(unsigned int index) {
  unsigned int low = 0, high = gb18030_range_count;
  while (low < high) {
    unsigned int middle = low + (high - low) / 2;
    if (index > gb18030_ranges[middle].last) {
      low = middle + 1;
    } else if (index < gb18030_ranges[middle].first) {
      high = middle;
    } else {
      return gb18030_ranges[middle].first_cp +
             (index - gb18030_ranges[middle].first);
    }
  }
  return REPLACEMENT;
}

static size_t decode_gb18030(const unsigned char *s, size_t left,
                             unsigned int *cp) {
  if (s[0] < 0x81 || s[0] == 0xFF || left < 2 || s[1] < 0x30 || s[1] > 0x39) {
    return decode_double_byte(gbk, s, left, cp);
  }
  if (left < 4 || s[2] < 0x81 || s[2] > 0xFE || s[3] < 0x30 || s[3] > 0x39) {
    *cp = REPLACEMENT;
    return 1;
  }
  unsigned int tail =
      (s[1] - 0x30) * 1260u + (s[2] - 0x81) * 10u + (s[3] - 0x30);
  if (s[0] <= 0x84) {
    *cp = gb18030_bmp((s[0] - 0x81) * 12600u + tail);
  } else if (s[0] >= 0x90 && s[0] <= 0xE3) {
    unsigned int value = 0x10000 + (s[0] - 0x90) * 12600u + tail;
    *cp = value <= 0x10FFFF ? value : REPLACEMENT;
  } else {
    *cp = REPLACEMENT;
  }
  return 4;
}

static size_t decode_shift_jis(const unsigned char *s, size_t left,
                               unsigned int *cp) {
  unsigned char lead = s[0];
  if (lead < 0x80) {
    *cp = lead;
    return 1;
  }
  if (lead >= 0xA1 && lead <= 0xDF) {
    *cp = 0xFF61 + (lead - 0xA1);
    return 1;
  }
  int row = lead >= 0x81 && lead <= 0x9F   ? lead - 0x81
            : lead >= 0xE0 && lead <= 0xFC ? lead - 0xE0 + 31
                                           : -1;
  if (row < 0 || left < 2 || s[1] < 0x40 || s[1] > 0xFC) {
    *cp = REPLACEMENT;
    return 1;
  }
  *cp = mapped(cp932[row * 189 + (s[1] - 0x40)]);
  return 2;
}

static size_t decode_jis_pair(unsigned char first, unsigned char second,
                              unsigned int *cp) {
  *cp = mapped(jis0208[first * 94 + second]);
  return 2;
}

static size_t decode_euc_jp(const unsigned char *s, size_t left,
                            unsigned int *cp) {
  unsigned char c = s[0];
  if (c < 0x80) {
    *cp = c;
    return 1;
  }
  if (c == 0x8E && left >= 2 && s[1] >= 0xA1 && s[1] <= 0xDF) {
    *cp = 0xFF61 + (s[1] - 0xA1);
    return 2;
  }
  if (c == 0x8F && left >= 3) { // JIS X 0212 has no table here
    *cp = REPLACEMENT;
    return 3;
  }
  if (c >= 0xA1 && c <= 0xFE && left >= 2 && s[1] >= 0xA1 && s[1] <= 0xFE) {
    return decode_jis_pair(c - 0xA1, s[1] - 0xA1, cp);
  }
  *cp = REPLACEMENT;
  return 1;
}

enum jis_mode { JIS_ASCII, JIS_KANJI, JIS_KATAKANA };

static size_t decode_iso_2022_jp(const unsigned char *s, size_t left,
                                 enum jis_mode *mode, unsigned int *cp) {
  if (s[0] == 0x1B && left >= 3) { // an escape sequence selects a character set
    if (s[1] == '$' && (s[2] == 'B' || s[2] == '@')) {
      *mode = JIS_KANJI;
      *cp = 0;
      return 3;
    }
    if (s[1] == '(' && (s[2] == 'B' || s[2] == 'J')) {
      *mode = JIS_ASCII;
      *cp = 0;
      return 3;
    }
    if (s[1] == '(' && s[2] == 'I') {
      *mode = JIS_KATAKANA;
      *cp = 0;
      return 3;
    }
  }
  unsigned char c = s[0];
  if (c >= 0x80) {
    *cp = REPLACEMENT;
    return 1;
  }
  if (*mode == JIS_KATAKANA && c >= 0x21 && c <= 0x5F) {
    *cp = 0xFF61 + (c - 0x21);
    return 1;
  }
  if (*mode == JIS_KANJI && c >= 0x21 && c <= 0x7E) {
    if (left < 2 || s[1] < 0x21 || s[1] > 0x7E) {
      *cp = REPLACEMENT;
      return 1;
    }
    return decode_jis_pair(c - 0x21, s[1] - 0x21, cp);
  }
  *cp = c;
  return 1;
}

int charconv_buffer(const char *tocode, const char *fromcode, const char *str,
                    size_t length, char **result, size_t *result_len) {
  struct source src;
  if (strcasecmp(tocode, "utf-8") != 0 || !source_of(fromcode, &src)) {
    return MAIL_CHARCONV_ERROR_UNKNOWN_CHARSET;
  }
  if (length > (size_t)-1 / 3 - 1) return MAIL_CHARCONV_ERROR_MEMORY;

  // A byte becomes at most three bytes of UTF-8; only a four-byte source
  // sequence becomes four
  char *out = malloc(length * 3 + 1);
  if (out == NULL) return MAIL_CHARCONV_ERROR_MEMORY;

  const unsigned char *s = (const unsigned char *)str;
  enum jis_mode mode = JIS_ASCII;
  size_t n = 0;
  for (size_t i = 0; i < length;) {
    size_t left = length - i;
    unsigned int cp = REPLACEMENT;
    size_t used = 1;
    switch (src.kind) {
    case KIND_UTF8:
      used = decode_utf8(s + i, left, &cp);
      break;
    case KIND_SINGLE_BYTE:
      cp = s[i] < 0x80 ? s[i] : mapped(src.high[s[i] - 0x80]);
      break;
    case KIND_SHIFT_JIS:
      used = decode_shift_jis(s + i, left, &cp);
      break;
    case KIND_EUC_JP:
      used = decode_euc_jp(s + i, left, &cp);
      break;
    case KIND_ISO_2022_JP:
      used = decode_iso_2022_jp(s + i, left, &mode, &cp);
      break;
    case KIND_GB18030:
      used = decode_gb18030(s + i, left, &cp);
      break;
    case KIND_CP950:
      used = decode_double_byte(cp950, s + i, left, &cp);
      break;
    case KIND_CP949:
      used = decode_double_byte(cp949, s + i, left, &cp);
      break;
    }
    i += used;
    if (cp != 0 || (src.kind != KIND_ISO_2022_JP)) {
      n += put_utf8(out + n, cp);
    }
  }
  out[n] = '\0';
  *result = out;
  *result_len = n;
  return MAIL_CHARCONV_NO_ERROR;
}

int charconv(const char *tocode, const char *fromcode, const char *str,
             size_t length, char **result) {
  size_t ignored;
  return charconv_buffer(tocode, fromcode, str, length, result, &ignored);
}

void charconv_buffer_free(char *str) { free(str); }
