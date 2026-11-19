#pragma once

#include "wasm_symbol.h"

void relaySend() WASM_SYMBOL_EXPORTED("canister_update relaySend");
void stub_commit() WASM_SYMBOL_EXPORTED("canister_update stub_commit");
void stub_set_mode() WASM_SYMBOL_EXPORTED("canister_update stub_set_mode");
void stub_finish() WASM_SYMBOL_EXPORTED("canister_update stub_finish");
void stub_reset() WASM_SYMBOL_EXPORTED("canister_update stub_reset");
void stub_stats() WASM_SYMBOL_EXPORTED("canister_query stub_stats");
