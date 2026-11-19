// The backend's Candid interface. It has no browser code, so the e2e tests
// can call the backend with it from Node.

import { IDL } from '@icp-sdk/core/candid'

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const MailboxInfo = IDL.Record({
    local: IDL.Text,
    address: IDL.Text,
    members: IDL.Nat64,
    message_count: IDL.Nat64,
    unseen: IDL.Nat64,
    used_bytes: IDL.Nat64,
    quota_bytes: IDL.Nat64,
    uidvalidity: IDL.Nat64,
  })
  const Me = IDL.Record({
    principal: IDL.Principal,
    name: IDL.Opt(IDL.Text),
    is_controller: IDL.Bool,
    mailboxes: IDL.Vec(MailboxInfo),
  })
  const Summary = IDL.Record({
    uid: IDL.Nat64,
    state: IDL.Nat64,
    flags: IDL.Nat64,
    modseq: IDL.Nat64,
    received_ns: IDL.Nat64,
    sent_at: IDL.Nat64,
    envelope_from: IDL.Text,
    subject: IDL.Text,
    sender: IDL.Text,
    attachments: IDL.Nat64,
    preview: IDL.Text,
    raw_bytes: IDL.Nat64,
    folder: IDL.Nat64,
  })
  const ListRequest = IDL.Record({
    cursor: IDL.Opt(IDL.Nat64),
    limit: IDL.Nat64,
  })
  const FolderRequest = IDL.Record({
    folder: IDL.Nat64,
    cursor: IDL.Opt(IDL.Nat64),
    limit: IDL.Nat64,
  })
  const SearchRequest = IDL.Record({
    query: IDL.Text,
    folder: IDL.Nat64,
    cursor: IDL.Opt(IDL.Nat64),
    limit: IDL.Nat64,
  })
  const Blocked = IDL.Record({
    address: IDL.Text,
    blocked_by: IDL.Principal,
    name: IDL.Opt(IDL.Text),
    at_ns: IDL.Nat64,
  })
  const Page = IDL.Record({
    items: IDL.Vec(Summary),
    cursor: IDL.Opt(IDL.Nat64),
  })
  const SeenBy = IDL.Record({
    principal: IDL.Principal,
    name: IDL.Opt(IDL.Text),
    at_ns: IDL.Nat64,
  })
  const FullMessage = IDL.Record({
    summary: Summary,
    raw: IDL.Vec(IDL.Nat8),
    seen_by: IDL.Vec(SeenBy),
  })
  const Attachment = IDL.Record({
    filename: IDL.Text,
    content: IDL.Vec(IDL.Nat8),
  })
  const SendRequest = IDL.Record({
    client_id: IDL.Text,
    to: IDL.Vec(IDL.Text),
    cc: IDL.Vec(IDL.Text),
    bcc: IDL.Vec(IDL.Text),
    subject: IDL.Text,
    html_body: IDL.Text,
    attachments: IDL.Vec(Attachment),
  })
  const OutboxSummary = IDL.Record({
    id: IDL.Nat64,
    state: IDL.Nat64,
    attempts: IDL.Nat64,
    created_ns: IDL.Nat64,
    to: IDL.Vec(IDL.Text),
    cc: IDL.Vec(IDL.Text),
    bcc: IDL.Vec(IDL.Text),
    subject: IDL.Text,
    attachments: IDL.Nat64,
    bytes: IDL.Nat64,
    last_error: IDL.Text,
    sent_by: IDL.Principal,
    sent_by_name: IDL.Opt(IDL.Text),
  })
  const OutboxPage = IDL.Record({
    items: IDL.Vec(OutboxSummary),
    cursor: IDL.Opt(IDL.Nat64),
  })
  const OutboxMessage = IDL.Record({
    summary: OutboxSummary,
    html_body: IDL.Text,
    attachments: IDL.Vec(Attachment),
  })
  const NewMailbox = IDL.Record({
    local: IDL.Text,
    quota_bytes: IDL.Opt(IDL.Nat64),
    first_member: IDL.Opt(IDL.Principal),
  })
  const Member = IDL.Record({
    principal: IDL.Principal,
    name: IDL.Opt(IDL.Text),
  })
  const Entry = IDL.Record({
    local: IDL.Text,
    members: IDL.Vec(Member),
    vacant: IDL.Bool,
    disabled: IDL.Bool,
    quota_bytes: IDL.Nat64,
    used_bytes: IDL.Nat64,
    message_count: IDL.Nat64,
    needs_repair: IDL.Opt(IDL.Text),
    uidvalidity: IDL.Nat64,
  })
  const IngestStats = IDL.Record({
    queued: IDL.Nat64,
    indexed: IDL.Nat64,
    quarantined: IDL.Nat64,
    quarantined_moves: IDL.Nat64,
  })
  const ExportInfo = IDL.Record({
    size: IDL.Nat64,
    started_ns: IDL.Nat64,
    until_ns: IDL.Nat64,
  })
  const ExportChunk = IDL.Record({
    data: IDL.Vec(IDL.Nat8),
    size: IDL.Nat64,
    started_ns: IDL.Nat64,
  })
  const StorageTotals = IDL.Record({
    mailboxes: IDL.Nat64,
    messages: IDL.Nat64,
    used_bytes: IDL.Nat64,
    database_bytes: IDL.Nat64,
    stable_memory_bytes: IDL.Nat64,
  })
  const Settings = IDL.Record({
    domain: IDL.Text,
    bridge: IDL.Opt(IDL.Principal),
  })

  return IDL.Service({
    // Each mail_ method but mail_me names its mailbox first
    mail_me: IDL.Func([], [Me], ['query']),
    mail_list: IDL.Func([IDL.Text, FolderRequest], [Page], ['query']),
    mail_get: IDL.Func([IDL.Text, IDL.Nat64], [FullMessage], ['query']),
    mail_search: IDL.Func([IDL.Text, SearchRequest], [Page], ['query']),
    mail_set_flags: IDL.Func(
      [IDL.Text, IDL.Vec(IDL.Nat64), IDL.Nat64, IDL.Nat64],
      [],
      []
    ),
    mail_delete: IDL.Func([IDL.Text, IDL.Vec(IDL.Nat64)], [IDL.Nat64], []),
    mail_move: IDL.Func(
      [IDL.Text, IDL.Vec(IDL.Nat64), IDL.Nat64],
      [IDL.Nat64],
      []
    ),
    mail_block: IDL.Func([IDL.Text, IDL.Text], [], []),
    mail_unblock: IDL.Func([IDL.Text, IDL.Text], [], []),
    mail_blocked: IDL.Func([IDL.Text], [IDL.Vec(Blocked)], ['query']),
    mail_send: IDL.Func([IDL.Text, SendRequest], [IDL.Nat64], []),
    mail_outbox_list: IDL.Func(
      [IDL.Text, ListRequest],
      [OutboxPage],
      ['query']
    ),
    mail_outbox_get: IDL.Func(
      [IDL.Text, IDL.Nat64],
      [OutboxMessage],
      ['query']
    ),
    mail_outbox_resend: IDL.Func([IDL.Text, IDL.Nat64], [], []),
    mail_outbox_delete: IDL.Func([IDL.Text, IDL.Nat64], [], []),
    mail_export_freeze: IDL.Func(
      [IDL.Text, IDL.Opt(IDL.Nat64)],
      [ExportInfo],
      []
    ),
    mail_export_thaw: IDL.Func([IDL.Text, IDL.Nat64], [], []),
    mail_export_chunk: IDL.Func(
      [IDL.Text, IDL.Record({ offset: IDL.Nat64, length: IDL.Nat64 })],
      [ExportChunk],
      ['query']
    ),
    admin_set_domain: IDL.Func([IDL.Text], [], []),
    admin_set_bridge: IDL.Func([IDL.Principal], [], []),
    admin_settings: IDL.Func([], [Settings], ['query']),
    admin_create_mailbox: IDL.Func([NewMailbox], [], []),
    admin_add_member: IDL.Func(
      [IDL.Text, IDL.Principal, IDL.Opt(IDL.Nat64)],
      [],
      []
    ),
    admin_remove_member: IDL.Func([IDL.Text, IDL.Principal], [], []),
    admin_set_name: IDL.Func([IDL.Principal, IDL.Text], [], []),
    admin_set_disabled: IDL.Func([IDL.Text, IDL.Bool], [], []),
    admin_set_quota: IDL.Func([IDL.Text, IDL.Nat64], [], []),
    admin_purge: IDL.Func(
      [IDL.Text],
      [IDL.Record({ remaining: IDL.Nat64 })],
      []
    ),
    admin_retry_moves: IDL.Func([IDL.Text], [IDL.Nat64], []),
    admin_check: IDL.Func(
      [IDL.Text, IDL.Opt(IDL.Text)],
      [IDL.Record({ result: IDL.Text, instructions: IDL.Nat64 })],
      []
    ),
    admin_list_entries: IDL.Func([], [IDL.Vec(Entry)], ['query']),
    admin_ingest_stats: IDL.Func([], [IngestStats], ['query']),
    admin_storage_totals: IDL.Func([], [StorageTotals], ['query']),
  })
}
