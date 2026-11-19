# The relay bridge

email-canister sends mail through a small method, `relaySend`, in a Caffeine app on the same domain. The app holds the key to Caffeine's mail gateway, which the backend canister cannot hold itself. These files are that method, ready to add to the app's Motoko backend.

## What it does

- Accepts a call only from your email-canister backend, with an `outboxId` of letters, digits and `-`, at most 128 characters.
- Builds the gateway's JSON itself, because a generated client exceeds the instruction limit on a 1.4 MB attachment. It escapes every control character, and refuses an attachment that is not base64.
- Derives the gateway's idempotency key from `outboxId`. A repeated call does not post while an earlier post may still be in flight; a post with no outcome after four minutes, the time an outcall and its one retry take to time out, counts as one that may have sent.
- Reports `#sent` when the gateway accepted the message, and keeps it: a repeated call reports it again and sends nothing. Delivery itself is never reported.
- Reports `#rejected` when the message was certainly not sent: the gateway refused or redirected it, or it was never posted, for instance because the app has no gateway settings or the escaped JSON is over the IC's 2 MB outcall limit, and no earlier attempt may have sent it. It is kept, like `#sent`, so a call that overlaps another for the same message does not post it again. Sending it again from the webmail makes a new attempt with a new key.
- Reports `#sending` while a post is in flight, and after a rate limit, a server error, a lost response or an outcall the IC could not make just now, within the first eight minutes of the gateway's 10-minute replay window. Each repeated call in that time posts again with the same key, so the gateway sends the message at most once. The two minutes left cover an outcall that times out and its one retry.
- After the window, reports `#rejected` when no attempt reached the gateway or the gateway rate limited each one, and otherwise `#unknown`: the message may or may not have been sent. `#unknown` is kept, but a post still in flight that ends in `#sent` corrects it.
- Keeps what it knows about each attempt in the results map, so an upgrade of the app while a message is being sent loses nothing.
- Removes a kept result 7 days after it was kept. The backend, from v0.2.0, never asks about a message for longer than a day. Each call looks at 50 entries, so the map stops growing with every message sent.

## Adding it to a Caffeine app

1. In the Caffeine project, enable email sending for the domain.
2. Add the dependencies to `mops.toml`: `caffeineai-email = "0.5.0"`, which brings `caffeine-integrations-mail-client` 0.7.0.
3. Copy `lib/relay.mo`, `mixins/relay-api.mo` and `types/relay.mo` into the backend's `lib/`, `mixins/` and `types/` folders.
4. In `lib/relay.mo`, set `relayCaller` to your backend canister's id. Until it is set, every call is refused.
5. In the actor, add the results map and include the mixin:
   ```motoko
   import Map "mo:core/Map";
   import RelayTypes "types/relay";
   import RelayApi "mixins/relay-api";

   actor {
     let relayResults = Map.empty<Text, RelayTypes.RelayStatus>();
     include RelayApi(relayResults);
   };
   ```
   An app that declares its state through a migration instead declares `let relayResults : Map.Map<Text, RelayTypes.RelayStatus>;` and has its migration start it as `Map.empty()`. The bridge keeps its other records in the same map, so an update of the bridge never needs a change to the actor or a migration.
6. Deploy the app, then tell the backend which canister the bridge is: `admin_set_bridge(principal "<the app's backend canister id>")`.
7. A Caffeine engine pays for the bridge's outcalls. Elsewhere, keep cycles on the app's backend canister: a request near 2 MB costs about 16 billion cycles on a 13-node subnet.

## Notes

- `relayResults` holds, besides each message's status, a note under `<outboxId>/note`: about the last attempt while the message is being sent, and when its result was kept after that. Code of the app that lists the whole map sees the notes too; `get` with an `outboxId` never does.
- A message's entries take a few hundred bytes, plus its error text, at most 1024 characters, for 7 days.
- The gateway adds an open-tracking pixel to every message and sets its own `Message-ID`, so replies may not thread in the recipient's mail program.
- Messages are HTML only.
- The gateway's operator can read outbound mail.
