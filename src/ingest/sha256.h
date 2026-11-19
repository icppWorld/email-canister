#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

// The SHA-256 of the data, in lower-case hex
std::string sha256_hex(const uint8_t *data, size_t size);
