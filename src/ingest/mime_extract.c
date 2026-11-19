#include "mime_extract.h"

#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "charconv.h"
#include "clist.h"
#include "mailimf.h"
#include "mailmime.h"
#include "mailmime_content.h"
#include "mailmime_decode.h"
#include "mmapstring.h"

#define MAX_TEXT (256 * 1024)
#define MAX_DEPTH 32

typedef struct Text {
  char *data;
  size_t length;
  int truncated;
} Text;

static void text_append(Text *text, const char *data, size_t length) {
  if (text->data == NULL) {
    text->data = malloc(MAX_TEXT + 1);
    if (text->data == NULL) return;
  }
  size_t room = MAX_TEXT - text->length;
  if (length > room) {
    length = room;
    text->truncated = 1;
  }
  memcpy(text->data + text->length, data, length);
  text->length += length;
}

// Ends the text with a NUL, removing a character cut in half by the cap
static char *text_finish(Text *text) {
  if (text->data == NULL) return NULL;
  if (text->truncated) {
    while (text->length > 0 &&
           ((unsigned char)text->data[text->length - 1] & 0xC0) == 0x80) {
      text->length--;
    }
    if (text->length > 0 &&
        (unsigned char)text->data[text->length - 1] >= 0xC0) {
      text->length--;
    }
  }
  text->data[text->length] = '\0';
  return text->data;
}

static int starts_with_nocase(const char *s, size_t left, const char *word) {
  size_t n = strlen(word);
  return left >= n && strncasecmp(s, word, n) == 0;
}

// Keeps what a reader sees: no tags, and no script or style content
static void strip_html(Text *out, const char *html, size_t length) {
  size_t i = 0;
  while (i < length) {
    if (html[i] != '<') {
      size_t start = i;
      while (i < length && html[i] != '<')
        i++;
      text_append(out, html + start, i - start);
      continue;
    }
    const char *closing = NULL;
    if (starts_with_nocase(html + i, length - i, "<script")) {
      closing = "</script";
    } else if (starts_with_nocase(html + i, length - i, "<style")) {
      closing = "</style";
    }
    if (closing != NULL) {
      while (i < length && !starts_with_nocase(html + i, length - i, closing)) {
        i++;
      }
    }
    while (i < length && html[i] != '>')
      i++;
    if (i < length) i++;
    text_append(out, " ", 1);
  }
}

static char *decode_header(const char *value) {
  size_t index = 0;
  char *decoded = NULL;
  if (mailmime_encoded_phrase_parse("utf-8", value, strlen(value), &index,
                                    "utf-8", &decoded) == MAILIMF_NO_ERROR) {
    return decoded;
  }
  return NULL;
}

static char *format_sender(const struct mailimf_mailbox *mailbox) {
  const char *address = mailbox->mb_addr_spec ? mailbox->mb_addr_spec : "";
  char *name =
      mailbox->mb_display_name ? decode_header(mailbox->mb_display_name) : NULL;
  size_t size = strlen(address) + (name ? strlen(name) : 0) + 4;
  char *out = malloc(size);
  if (out != NULL) {
    if (name != NULL && name[0] != '\0') {
      strcpy(out, name);
      strcat(out, " <");
      strcat(out, address);
      strcat(out, ">");
    } else {
      strcpy(out, address);
    }
  }
  free(name);
  return out;
}

static char *copy_text(const char *text) {
  const size_t size = strlen(text) + 1;
  char *out = malloc(size);
  if (out != NULL) memcpy(out, text, size);
  return out;
}

static int64_t days_from_civil(int64_t y, int m, int d) {
  y -= m <= 2;
  int64_t era = (y >= 0 ? y : y - 399) / 400;
  int64_t yoe = y - era * 400;
  int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

static int64_t epoch_seconds(const struct mailimf_date_time *date) {
  if (date->dt_month < 1 || date->dt_month > 12 || date->dt_day < 1 ||
      date->dt_day > 31 || date->dt_year < 1970 || date->dt_year > 9999) {
    return 0;
  }
  int zone = date->dt_zone; // +hhmm as a decimal number
  int zone_abs = zone < 0 ? -zone : zone;
  int64_t offset = (zone_abs / 100) * 3600 + (zone_abs % 100) * 60;
  int64_t seconds =
      days_from_civil(date->dt_year, date->dt_month, date->dt_day) * 86400 +
      date->dt_hour * 3600 + date->dt_min * 60 + date->dt_sec;
  seconds = zone < 0 ? seconds + offset : seconds - offset;
  // Before the epoch, as early on 1970-01-01 east of UTC, it is unknown too
  return seconds < 0 ? 0 : seconds;
}

static void read_fields(const struct mailimf_fields *fields, MimeSummary *out) {
  if (fields == NULL) return;
  for (clistiter *it = clist_begin(fields->fld_list); it != NULL;
       it = clist_next(it)) {
    const struct mailimf_field *field = clist_content(it);
    switch (field->fld_type) {
    case MAILIMF_FIELD_SUBJECT:
      if (out->subject == NULL) {
        out->subject = decode_header(field->fld_data.fld_subject->sbj_value);
      }
      break;
    case MAILIMF_FIELD_FROM: {
      const struct mailimf_mailbox_list *list =
          field->fld_data.fld_from->frm_mb_list;
      if (out->sender == NULL && list != NULL &&
          !clist_isempty(list->mb_list)) {
        const struct mailimf_mailbox *first =
            clist_content(clist_begin(list->mb_list));
        out->sender = format_sender(first);
        out->sender_address =
            first->mb_addr_spec ? copy_text(first->mb_addr_spec) : NULL;
      }
      break;
    }
    case MAILIMF_FIELD_ORIG_DATE:
      out->sent_at_seconds =
          epoch_seconds(field->fld_data.fld_orig_date->dt_date_time);
      break;
    default:
      break;
    }
  }
}

static int is_attachment(const struct mailmime *mime) {
  if (mime->mm_mime_fields == NULL) return 0;
  for (clistiter *it = clist_begin(mime->mm_mime_fields->fld_list); it != NULL;
       it = clist_next(it)) {
    const struct mailmime_field *field = clist_content(it);
    if (field->fld_type == MAILMIME_FIELD_DISPOSITION &&
        field->fld_data.fld_disposition->dsp_type->dsp_type ==
            MAILMIME_DISPOSITION_TYPE_ATTACHMENT) {
      return 1;
    }
  }
  return 0;
}

static const char *charset_of(const struct mailmime_content *content) {
  if (content != NULL && content->ct_parameters != NULL) {
    for (clistiter *it = clist_begin(content->ct_parameters); it != NULL;
         it = clist_next(it)) {
      const struct mailmime_parameter *parameter = clist_content(it);
      if (strcasecmp(parameter->pa_name, "charset") == 0) {
        return parameter->pa_value;
      }
    }
  }
  return "us-ascii";
}

// 0: not text. 1: text/plain. 2: text/html.
static int text_kind(const struct mailmime_content *content) {
  if (content == NULL) return 1; // RFC 2045 default
  if (content->ct_type->tp_type != MAILMIME_TYPE_DISCRETE_TYPE ||
      content->ct_type->tp_data.tp_discrete_type->dt_type !=
          MAILMIME_DISCRETE_TYPE_TEXT) {
    return 0;
  }
  if (strcasecmp(content->ct_subtype, "plain") == 0) return 1;
  if (strcasecmp(content->ct_subtype, "html") == 0) return 2;
  return 0;
}

static void read_single(const struct mailmime *mime, Text *plain, Text *html,
                        MimeSummary *out) {
  if (is_attachment(mime)) {
    out->attachments++;
    return;
  }
  int kind = text_kind(mime->mm_content_type);
  const struct mailmime_data *body = mime->mm_data.mm_single;
  if (kind == 0 || body == NULL || body->dt_type != MAILMIME_DATA_TEXT) return;

  size_t index = 0;
  char *decoded = NULL;
  size_t decoded_length = 0;
  if (body->dt_encoded) {
    if (mailmime_part_parse(body->dt_data.dt_text.dt_data,
                            body->dt_data.dt_text.dt_length, &index,
                            body->dt_encoding, &decoded,
                            &decoded_length) != MAILIMF_NO_ERROR) {
      return;
    }
  }
  const char *bytes = decoded ? decoded : body->dt_data.dt_text.dt_data;
  size_t length = decoded ? decoded_length : body->dt_data.dt_text.dt_length;

  char *utf8 = NULL;
  size_t utf8_length = 0;
  if (charconv_buffer("utf-8", charset_of(mime->mm_content_type), bytes, length,
                      &utf8, &utf8_length) == MAIL_CHARCONV_NO_ERROR ||
      charconv_buffer("utf-8", "iso-8859-1", bytes, length, &utf8,
                      &utf8_length) == MAIL_CHARCONV_NO_ERROR) {
    if (kind == 1) {
      text_append(plain, utf8, utf8_length);
      text_append(plain, "\n", 1);
    } else {
      strip_html(html, utf8, utf8_length);
    }
    charconv_buffer_free(utf8);
  }
  if (decoded != NULL) mmap_string_unref(decoded);
}

static void walk(const struct mailmime *mime, int depth, Text *plain,
                 Text *html, MimeSummary *out) {
  if (depth > MAX_DEPTH) return;
  switch (mime->mm_type) {
  case MAILMIME_SINGLE:
    read_single(mime, plain, html, out);
    break;
  case MAILMIME_MULTIPLE:
    for (clistiter *it = clist_begin(mime->mm_data.mm_multipart.mm_mp_list);
         it != NULL; it = clist_next(it)) {
      walk(clist_content(it), depth + 1, plain, html, out);
    }
    break;
  case MAILMIME_MESSAGE:
    if (depth == 0) {
      read_fields(mime->mm_data.mm_message.mm_fields, out);
      if (mime->mm_data.mm_message.mm_msg_mime != NULL) {
        walk(mime->mm_data.mm_message.mm_msg_mime, depth + 1, plain, html, out);
      }
    } else {
      out->attachments++; // an attached message is not part of this one's text
    }
    break;
  default:
    break;
  }
}

int mime_extract(const char *data, size_t length, MimeSummary *out) {
  memset(out, 0, sizeof *out);
  size_t index = 0;
  struct mailmime *mime = NULL;
  int result = mailmime_parse(data, length, &index, &mime);
  if (result != MAILIMF_NO_ERROR) return result;

  Text plain = {NULL, 0, 0};
  Text html = {NULL, 0, 0};
  walk(mime, 0, &plain, &html, out);
  mailmime_free(mime);

  if (plain.length > 0) {
    out->text = text_finish(&plain);
    free(html.data);
  } else {
    out->text = text_finish(&html);
    free(plain.data);
  }
  return 0;
}

void mime_summary_free(MimeSummary *summary) {
  free(summary->subject);
  free(summary->sender);
  free(summary->sender_address);
  free(summary->text);
  memset(summary, 0, sizeof *summary);
}
