// The canister's exported methods

#pragma once

#include "wasm_symbol.h"

void canister_init() WASM_SYMBOL_EXPORTED("canister_init");
void canister_post_upgrade() WASM_SYMBOL_EXPORTED("canister_post_upgrade");

void smtp_request_validate()
    WASM_SYMBOL_EXPORTED("canister_query smtp_request_validate");
void smtp_request() WASM_SYMBOL_EXPORTED("canister_update smtp_request");

// Called only by the canister itself
void outbox_pump() WASM_SYMBOL_EXPORTED("canister_update outbox_pump");
void ingest_pump() WASM_SYMBOL_EXPORTED("canister_update ingest_pump");
void ingest_move() WASM_SYMBOL_EXPORTED("canister_update ingest_move");
void ingest_process() WASM_SYMBOL_EXPORTED("canister_update ingest_process");
void ingest_merge() WASM_SYMBOL_EXPORTED("canister_update ingest_merge");
void ingest_clean() WASM_SYMBOL_EXPORTED("canister_update ingest_clean");
void ingest_upgrade_file()
    WASM_SYMBOL_EXPORTED("canister_update ingest_upgrade_file");

void admin_set_domain()
    WASM_SYMBOL_EXPORTED("canister_update admin_set_domain");
void admin_set_bridge()
    WASM_SYMBOL_EXPORTED("canister_update admin_set_bridge");
void admin_settings() WASM_SYMBOL_EXPORTED("canister_query admin_settings");
void admin_create_mailbox()
    WASM_SYMBOL_EXPORTED("canister_update admin_create_mailbox");
void admin_add_member()
    WASM_SYMBOL_EXPORTED("canister_update admin_add_member");
void admin_remove_member()
    WASM_SYMBOL_EXPORTED("canister_update admin_remove_member");
void admin_set_name() WASM_SYMBOL_EXPORTED("canister_update admin_set_name");
void admin_set_disabled()
    WASM_SYMBOL_EXPORTED("canister_update admin_set_disabled");
void admin_set_quota() WASM_SYMBOL_EXPORTED("canister_update admin_set_quota");
void admin_purge() WASM_SYMBOL_EXPORTED("canister_update admin_purge");
void admin_retry_moves()
    WASM_SYMBOL_EXPORTED("canister_update admin_retry_moves");
void admin_check() WASM_SYMBOL_EXPORTED("canister_update admin_check");
void admin_list_entries()
    WASM_SYMBOL_EXPORTED("canister_query admin_list_entries");
void admin_ingest_stats()
    WASM_SYMBOL_EXPORTED("canister_query admin_ingest_stats");
void admin_storage_totals()
    WASM_SYMBOL_EXPORTED("canister_query admin_storage_totals");

void mail_me() WASM_SYMBOL_EXPORTED("canister_query mail_me");
void mail_list() WASM_SYMBOL_EXPORTED("canister_query mail_list");
void mail_get() WASM_SYMBOL_EXPORTED("canister_query mail_get");
void mail_search() WASM_SYMBOL_EXPORTED("canister_query mail_search");
void mail_set_flags() WASM_SYMBOL_EXPORTED("canister_update mail_set_flags");
void mail_delete() WASM_SYMBOL_EXPORTED("canister_update mail_delete");
void mail_move() WASM_SYMBOL_EXPORTED("canister_update mail_move");
void mail_block() WASM_SYMBOL_EXPORTED("canister_update mail_block");
void mail_unblock() WASM_SYMBOL_EXPORTED("canister_update mail_unblock");
void mail_blocked() WASM_SYMBOL_EXPORTED("canister_query mail_blocked");
void mail_send() WASM_SYMBOL_EXPORTED("canister_update mail_send");
void mail_outbox_list() WASM_SYMBOL_EXPORTED("canister_query mail_outbox_list");
void mail_outbox_get() WASM_SYMBOL_EXPORTED("canister_query mail_outbox_get");
void mail_outbox_resend()
    WASM_SYMBOL_EXPORTED("canister_update mail_outbox_resend");
void mail_outbox_delete()
    WASM_SYMBOL_EXPORTED("canister_update mail_outbox_delete");
void mail_outbox_delete_many()
    WASM_SYMBOL_EXPORTED("canister_update mail_outbox_delete_many");
void mail_export_freeze()
    WASM_SYMBOL_EXPORTED("canister_update mail_export_freeze");
void mail_export_thaw()
    WASM_SYMBOL_EXPORTED("canister_update mail_export_thaw");
void mail_export_chunk()
    WASM_SYMBOL_EXPORTED("canister_query mail_export_chunk");
void mail_cal_list() WASM_SYMBOL_EXPORTED("canister_query mail_cal_list");
void mail_cal_put() WASM_SYMBOL_EXPORTED("canister_update mail_cal_put");
void mail_cal_delete() WASM_SYMBOL_EXPORTED("canister_update mail_cal_delete");
void mail_cal_feed() WASM_SYMBOL_EXPORTED("canister_query mail_cal_feed");
void mail_cal_feed_reset()
    WASM_SYMBOL_EXPORTED("canister_update mail_cal_feed_reset");
void mail_cal_feed_stop()
    WASM_SYMBOL_EXPORTED("canister_update mail_cal_feed_stop");

// The calendar feed, for anyone who has its address
void http_request() WASM_SYMBOL_EXPORTED("canister_query http_request");
void http_request_update()
    WASM_SYMBOL_EXPORTED("canister_update http_request_update");

#ifdef EMAIL_CANISTER_TEST_HOOKS
void dev_pause() WASM_SYMBOL_EXPORTED("canister_update dev_pause");
void dev_set_backlog_cap()
    WASM_SYMBOL_EXPORTED("canister_update dev_set_backlog_cap");
void dev_message() WASM_SYMBOL_EXPORTED("canister_query dev_message");
void dev_search() WASM_SYMBOL_EXPORTED("canister_query dev_search");
void dev_outbox_timing()
    WASM_SYMBOL_EXPORTED("canister_update dev_outbox_timing");
void dev_outbox_crash()
    WASM_SYMBOL_EXPORTED("canister_update dev_outbox_crash");
void dev_set_budgets() WASM_SYMBOL_EXPORTED("canister_update dev_set_budgets");
void dev_seed() WASM_SYMBOL_EXPORTED("canister_update dev_seed");
void dev_search_cost() WASM_SYMBOL_EXPORTED("canister_query dev_search_cost");
void dev_set_dedupe_window()
    WASM_SYMBOL_EXPORTED("canister_update dev_set_dedupe_window");
void dev_trap_moves() WASM_SYMBOL_EXPORTED("canister_update dev_trap_moves");
void dev_last_cost() WASM_SYMBOL_EXPORTED("canister_query dev_last_cost");
void dev_hide_file() WASM_SYMBOL_EXPORTED("canister_update dev_hide_file");
void dev_cache() WASM_SYMBOL_EXPORTED("canister_query dev_cache");
void dev_stat() WASM_SYMBOL_EXPORTED("canister_query dev_stat");
void dev_set_export_timing()
    WASM_SYMBOL_EXPORTED("canister_update dev_set_export_timing");
void dev_schema_step() WASM_SYMBOL_EXPORTED("canister_update dev_schema_step");
void dev_file_exec() WASM_SYMBOL_EXPORTED("canister_update dev_file_exec");
void dev_damage_file() WASM_SYMBOL_EXPORTED("canister_update dev_damage_file");
void dev_fail_statements()
    WASM_SYMBOL_EXPORTED("canister_update dev_fail_statements");
void dev_clean_due() WASM_SYMBOL_EXPORTED("canister_query dev_clean_due");
#endif
