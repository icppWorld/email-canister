// Converts hex-encoded input to UTF-8 and prints it as hex, for test_charsets.py.
// Usage: charconv_harness <charset> <hex>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "charconv.h"

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  size_t length = strlen(argv[2]) / 2;
  char *input = malloc(length + 1);
  for (size_t i = 0; i < length; i++) {
    unsigned int byte;
    sscanf(argv[2] + 2 * i, "%2x", &byte);
    input[i] = (char)byte;
  }
  char *output = NULL;
  size_t output_length = 0;
  if (charconv_buffer("utf-8", argv[1], input, length, &output,
                      &output_length) != MAIL_CHARCONV_NO_ERROR) {
    printf("error\n");
    return 0;
  }
  for (size_t i = 0; i < output_length; i++) {
    printf("%02x", (unsigned char)output[i]);
  }
  printf("\n");
  charconv_buffer_free(output);
  free(input);
  return 0;
}
