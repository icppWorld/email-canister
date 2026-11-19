// The four functions libetpan's MIME parser needs from
// mailmime_types_helper.c. That file also builds outgoing messages with
// gethostname and getpid, which a canister does not have, so it is not
// compiled. The code below is taken unchanged from libetpan, whose licence is
// in vendor/libetpan/COPYRIGHT.

#include <stdlib.h>
#include <string.h>

#include "clist.h"
#include "mailmime.h"
#include "mailmime_types_helper.h"

int mailmime_transfer_encoding_get(struct mailmime_fields *fields) {
  clistiter *cur;

  for (cur = clist_begin(fields->fld_list); cur != NULL; cur = clist_next(cur)) {
    struct mailmime_field *field;

    field = clist_content(cur);
    if (field->fld_type == MAILMIME_FIELD_TRANSFER_ENCODING)
      return field->fld_data.fld_encoding->enc_type;
  }

  return MAILMIME_MECHANISM_8BIT;
}

struct mailmime_fields *mailmime_fields_new_empty(void) {
  clist *list;
  struct mailmime_fields *fields;

  list = clist_new();
  if (list == NULL)
    goto err;

  fields = mailmime_fields_new(list);
  if (fields == NULL)
    goto free;

  return fields;

free:
  clist_free(list);
err:
  return NULL;
}

struct mailmime_content *mailmime_get_content_message(void) {
  clist *list;
  struct mailmime_composite_type *composite_type;
  struct mailmime_type *mime_type;
  struct mailmime_content *content;
  char *subtype;

  composite_type =
      mailmime_composite_type_new(MAILMIME_COMPOSITE_TYPE_MESSAGE, NULL);
  if (composite_type == NULL)
    goto err;

  mime_type = mailmime_type_new(MAILMIME_TYPE_COMPOSITE_TYPE, NULL, composite_type);
  if (mime_type == NULL)
    goto free_composite;
  composite_type = NULL;

  list = clist_new();
  if (list == NULL)
    goto free_mime_type;

  subtype = strdup("rfc822");
  if (subtype == NULL)
    goto free_list;

  content = mailmime_content_new(mime_type, subtype, list);
  if (content == NULL)
    goto free_subtype;

  return content;

free_subtype:
  free(subtype);
free_list:
  clist_free(list);
free_mime_type:
  mailmime_type_free(mime_type);
free_composite:
  if (composite_type != NULL)
    mailmime_composite_type_free(composite_type);
err:
  return NULL;
}

struct mailmime_content *mailmime_get_content_text(void) {
  clist *list;
  struct mailmime_discrete_type *discrete_type;
  struct mailmime_type *mime_type;
  struct mailmime_content *content;
  char *subtype;

  discrete_type = mailmime_discrete_type_new(MAILMIME_DISCRETE_TYPE_TEXT, NULL);
  if (discrete_type == NULL)
    goto err;

  mime_type = mailmime_type_new(MAILMIME_TYPE_DISCRETE_TYPE, discrete_type, NULL);
  if (mime_type == NULL)
    goto free_discrete;
  discrete_type = NULL;

  list = clist_new();
  if (list == NULL)
    goto free_type;

  subtype = strdup("plain");
  if (subtype == NULL)
    goto free_list;

  content = mailmime_content_new(mime_type, subtype, list);
  if (content == NULL)
    goto free_subtype;

  return content;

free_subtype:
  free(subtype);
free_list:
  clist_free(list);
free_type:
  mailmime_type_free(mime_type);
free_discrete:
  if (discrete_type != NULL)
    mailmime_discrete_type_free(discrete_type);
err:
  return NULL;
}
