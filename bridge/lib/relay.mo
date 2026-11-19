import Cycles "mo:core/Cycles";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";
import VarArray "mo:core/VarArray";
import EmailClient "mo:caffeineai-email/emailClient";
import { type Config; _Helpers; _Ic } "mo:caffeine-integrations-mail-client/Config";
import Types "../types/relay";

module {
  /// The mail gateway replays the response to a repeated idempotency key for
  /// 10 minutes, so posting again within them cannot send twice. A post must
  /// reach the gateway in that time. An outcall can take about a minute to
  /// time out, and is then retried once, so the bridge posts only in the first
  /// eight minutes: this many nanoseconds.
  let postWindow : Int = 480_000_000_000;

  /// A post still marked in flight after this long will never report back,
  /// for instance because an upgrade ended it: its outcall and the one retry
  /// time out in about two minutes. Four minutes, in nanoseconds.
  let inFlightFor : Int = 240_000_000_000;

  /// A final result is removed this long after it was kept: 7 days, in
  /// nanoseconds. The backend, from v0.2.0, asks about an email for at most
  /// a day.
  let retention : Int = 604_800_000_000_000;

  /// The entries each call looks at for removal.
  let sweepSize = 50;

  let maxOutboxIdSize = 128;

  /// Error text is cut to this many characters.
  let maxErrorSize = 1024;

  /// The largest outcall request the IC makes: its URL, headers and body.
  let maxRequestBytes = 2_000_000;

  /// Your email-canister backend's canister id: the only caller that may send
  /// email through the relay. While this holds a placeholder instead of an id,
  /// Principal.fromText traps and every call is refused.
  let relayCaller = "SET-TO-YOUR-BACKEND-CANISTER-ID";

  public func isRelayCaller(caller : Principal) : Bool {
    caller == Principal.fromText(relayCaller);
  };

  // Besides each email's status under its outboxId, the results map holds a
  // note under `<outboxId>/note`, a key no outboxId can have. It is stable,
  // so an upgrade loses nothing. While the email is #sending, the note is
  // about the last attempt: #sending(postedAt) while a post is in flight,
  // #unknown when it ended and may have sent the email, #rejected when it
  // ended and did not. Once the status is final, it is #sending(keptAt).
  let noteSuffix = "/note";
  func noteKey(outboxId : Text) : Text { outboxId # noteSuffix };

  /// Letters, digits and `-`: what the backend's keys use, and no `/`.
  func validOutboxId(outboxId : Text) : Bool {
    outboxId.size() > 0 and outboxId.size() <= maxOutboxIdSize and outboxId.chars().all(
      func(c : Char) : Bool { (c >= 'A' and c <= 'Z') or (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9') or c == '-' }
    );
  };

  /// The outcome of one attempt.
  type Outcome = {
    /// Accepted by the gateway.
    #sent;
    /// Not sent by this attempt: the gateway refused it, or it was never
    /// posted. An earlier attempt still may have sent it.
    #notSent : Text;
    /// Not sent by this attempt, and worth trying again: the gateway is rate
    /// limiting, or the outcall could not be made just now.
    #tryAgain : Text;
    /// It may or may not have been sent.
    #ambiguous : Text;
  };

  let hexDigits : [Nat8] = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66];

  /// `value` as a JSON string. It works on the UTF-8 bytes: every byte it
  /// escapes is ASCII, and no byte of a longer character is. Loops over an
  /// array cost far fewer instructions than building the text a character at
  /// a time, which matters on a body near 2 MB.
  ///
  /// The backend's outbox_encoded_size counts the bytes this escaping adds,
  /// so it refuses a message too large to post: change the two together.
  public func jsonString(value : Text) : Text {
    let bytes = value.encodeUtf8().toArray();
    var size = bytes.size() + 2;
    for (byte in bytes.values()) {
      if (byte < 0x20) {
        size += if (byte == 0x0a or byte == 0x0d or byte == 0x09) { 1 } else { 5 };
      } else if (byte == 0x22 or byte == 0x5c) { size += 1 };
    };
    if (size == bytes.size() + 2) { return "\"" # value # "\"" };

    // Starts and ends with its quotes
    let out = VarArray.repeat<Nat8>(0x22, size);
    var at = 1;
    for (byte in bytes.values()) {
      if (byte >= 0x20 and byte != 0x22 and byte != 0x5c) {
        out[at] := byte;
        at += 1;
      } else {
        out[at] := 0x5c;
        switch (byte) {
          case (0x22 or 0x5c) { out[at + 1] := byte; at += 2 };
          case 0x0a { out[at + 1] := 0x6e; at += 2 };
          case 0x0d { out[at + 1] := 0x72; at += 2 };
          case 0x09 { out[at + 1] := 0x74; at += 2 };
          case _ {
            out[at + 1] := 0x75;
            out[at + 2] := 0x30;
            out[at + 3] := 0x30;
            out[at + 4] := hexDigits[(byte / 16).toNat()];
            out[at + 5] := hexDigits[(byte % 16).toNat()];
            at += 6;
          };
        };
      };
    };
    let ?text = out.toBlob().decodeUtf8() else Runtime.trap("escaping broke the UTF-8");
    text;
  };

  func jsonArray(items : [Text]) : Text {
    var out = "";
    for (item in items.values()) {
      out #= (if (out == "") { "" } else { "," }) # item;
    };
    "[" # out # "]";
  };

  /// Whether `text` is standard base64: its alphabet, `=` padding only at the
  /// end, and a length that is a multiple of 4. Such text needs no escaping in
  /// JSON.
  public func isBase64(text : Text) : Bool {
    let bytes = text.encodeUtf8().toArray();
    var padding = 0;
    for (byte in bytes.values()) {
      if (byte == 0x3d) {
        padding += 1;
      } else if (padding > 0) {
        return false;
      } else if (not ((byte >= 0x41 and byte <= 0x5a) or (byte >= 0x61 and byte <= 0x7a) or (byte >= 0x30 and byte <= 0x39) or byte == 0x2b or byte == 0x2f)) {
        return false;
      };
    };
    bytes.size() % 4 == 0 and padding <= 2;
  };

  /// The body of a send request. It is written out here because the generated
  /// client's JSON encoder exceeds the instruction limit on a large attachment.
  /// The base64 content, checked by isBase64, needs no escaping, which is what
  /// keeps this cheap.
  func requestBody(request : Types.RelayRequest) : Blob {
    let attachments = request.attachments.map(
      func(attachment : Types.RelayAttachment) : Text {
        "{\"filename\":" # jsonString(attachment.filename)
        # ",\"content\":\"" # attachment.base64
        # "\",\"encoding\":\"base64\"}";
      }
    );
    (
      "{\"fromUsername\":" # jsonString(request.fromUsername)
      # ",\"to\":" # jsonArray(request.to.map(jsonString))
      # ",\"cc\":" # jsonArray(request.cc.map(jsonString))
      # ",\"bcc\":" # jsonArray(request.bcc.map(jsonString))
      # ",\"subject\":" # jsonString(request.subject)
      # ",\"htmlBody\":" # jsonString(request.htmlBody)
      # ",\"attachments\":" # jsonArray(attachments)
      # "}"
    ).encodeUtf8();
  };

  func truncate(text : Text) : Text {
    Text.fromIter(text.chars().take(maxErrorSize));
  };

  func httpOutcome(response : _Ic.HttpRequestResult) : Outcome {
    let status = response.status;
    if (status >= 200 and status < 300) { return #sent };
    let error = "HTTP " # status.toText() # ": " # (response.body.decodeUtf8() ?? "");
    if (status == 429) { return #tryAgain(truncate("rate limited: " # error)) };
    // The gateway sends nothing it redirects or answers with a client error.
    // These three say to try again later instead.
    if (status >= 300 and status < 500 and status != 408 and status != 409 and status != 425) {
      return #notSent(truncate(error));
    };
    #ambiguous(truncate(error));
  };

  public func sendRequest(config : Config, token : Text, key : Text, body : Blob) : _Ic.HttpRequestArgs {
    {
      config with
      url = config.baseUrl # "/api/mail/v2/send";
      method = #post;
      headers = [
        { name = "Content-Type"; value = "application/json; charset=utf-8" },
        { name = "Accept"; value = "application/json" },
        { name = "idempotency-key"; value = key },
        { name = "Authorization"; value = "Bearer " # token },
      ];
      body = ?body;
    };
  };

  /// The request's size as the IC counts it. `_Helpers.outcallFee` sizes it
  /// the same way but does not expose the number: change the two together.
  func requestBytes(request : _Ic.HttpRequestArgs) : Nat {
    var bytes = request.url.encodeUtf8().size();
    for (header in request.headers.values()) {
      bytes += header.name.encodeUtf8().size() + header.value.encodeUtf8().size();
    };
    // As the IC counts a transform: its method name at the longest allowed
    switch (request.transform) {
      case (?transform) { bytes += 20_000 + transform.context.size() };
      case null {};
    };
    bytes + (switch (request.body) { case (?body) { body.size() }; case null { 0 } });
  };

  /// The cycles to attach: the IC's fee for this request, but never more than
  /// the balance. A Caffeine engine reports a balance of 0 and pays for the
  /// outcall itself. Not the gateway config's `cycles`, which the mail client
  /// caps at 10B: a request near 2 MB costs about 16B.
  public func outcallCycles(config : Config, request : _Ic.HttpRequestArgs) : Nat {
    Nat.min(_Helpers.outcallFee(request, config.pricing_version), Cycles.balance());
  };

  /// A lost response is retried once with the same key, so the gateway replays
  /// its stored response instead of sending a second time. Not after the post
  /// window, where the retry could reach the gateway after its record expired.
  func post(config : Config, request : _Ic.HttpRequestArgs, firstAttemptAt : Int) : async* Outcome {
    func postOnce() : async* Outcome {
      httpOutcome(await (with cycles = outcallCycles(config, request)) _Ic.http_request(request));
    };
    try {
      await* postOnce();
    } catch (error) {
      switch (error.code()) {
        // The first post may have reached the gateway, so anything but the
        // retry's #sent leaves it in doubt
        case (#system_transient) {
          if (Time.now() - firstAttemptAt >= postWindow) {
            return #ambiguous(truncate(error.message()));
          };
          try {
            switch (await* postOnce()) {
              case (#sent) { #sent };
              case (#notSent error or #tryAgain error or #ambiguous error) {
                #ambiguous(error);
              };
            };
          } catch (retryError) {
            #ambiguous(truncate(retryError.message()));
          };
        };
        // The outcall was never made, for instance because the output queue
        // was full
        case (#call_error _) { #tryAgain(truncate(error.message())) };
        case _ { #ambiguous(truncate(error.message())) };
      };
    };
  };

  /// Looks at up to `sweepSize` entries, starting at the key `from`, and
  /// removes the emails kept longer than the retention period. Returns the key
  /// to start at next time; "" starts at the beginning.
  public func sweep(results : Map.Map<Text, Types.RelayStatus>, from : Text) : Text {
    let now = Time.now();
    // The map cannot change while it is being read
    let remove = List.empty<Text>();
    let stamp = List.empty<Text>();
    var seen = 0;
    var next = "";
    label scan for ((key, status) in results.entriesFrom(from)) {
      if (seen == sweepSize) {
        next := key;
        break scan;
      };
      seen += 1;
      // A note goes with its email, and without one
      switch (key.stripEnd(#text noteSuffix)) {
        case (?outboxId) {
          if (not results.containsKey(outboxId)) { remove.add(key) };
          continue scan;
        };
        case null {};
      };
      let since = switch (status) {
        // Abandoned while #sending: the backend stopped asking long ago
        case (#sending(startedAt)) { startedAt };
        case _ {
          switch (results.get(noteKey(key))) {
            case (?#sending(keptAt)) { keptAt };
            // Kept by an older bridge, which noted no time
            case _ {
              stamp.add(key);
              now;
            };
          };
        };
      };
      if (now - since > retention) {
        remove.add(key);
        remove.add(noteKey(key));
      };
    };
    for (key in remove.values()) { results.remove(key) };
    for (key in stamp.values()) { results.add(noteKey(key), #sending(now)) };
    next;
  };

  /// Send an email, or report what happened to the one with the same outboxId.
  ///
  /// `#sent`, `#rejected` and `#unknown` are kept under the outboxId and
  /// repeated: the backend takes them as final, and a call that overlaps
  /// another for the same email must not post it again. Any other outcome is
  /// retried within the post window with the same idempotency key, one post
  /// per call.
  public func send(results : Map.Map<Text, Types.RelayStatus>, request : Types.RelayRequest) : async* Types.RelayStatus {
    let outboxId = request.outboxId;
    if (not validOutboxId(outboxId)) {
      return #rejected("invalid outboxId");
    };

    // What the earlier calls for this email left
    var firstAttemptAt = Time.now();
    var mayHaveSent = false;
    // When this call posted, if it did
    var postedAt : ?Int = null;

    func keep(status : Types.RelayStatus) : Types.RelayStatus {
      results.add(outboxId, status);
      results.add(noteKey(outboxId), #sending(Time.now()));
      status;
    };

    // Takes in what a later call left in the note while this one's post was
    // in flight: that call posted too, so the email may have been sent.
    // Returns whether its post is still in flight.
    func readNote() : Bool {
      switch (postedAt, results.get(noteKey(outboxId))) {
        case (?mine, ?#sending(posted)) {
          if (posted != mine) {
            mayHaveSent := true;
            return true;
          };
        };
        case (_, ?#unknown _) { mayHaveSent := true };
        case _ {};
      };
      false;
    };

    // No final outcome yet. Within the post window the next call posts
    // again; after it, a new post could send a second time, so it stops.
    func notYet(error : Text) : Types.RelayStatus {
      let inWindow = Time.now() - firstAttemptAt < postWindow;
      if (readNote()) { return #sending(firstAttemptAt) };
      let status = if (mayHaveSent) { #unknown(error) } else { #rejected(error) };
      if (inWindow) {
        results.add(noteKey(outboxId), status);
        return #sending(firstAttemptAt);
      };
      // No attempt reached the gateway, or it refused to take them on
      keep(status);
    };

    // Records the outcome of this call's attempt. A #sent is the truth and
    // wins; otherwise a result another call kept meanwhile stays.
    func finish(outcome : Outcome) : Types.RelayStatus {
      switch (outcome, results.get(outboxId)) {
        case (#sent, _) { keep(#sent) };
        case (#notSent(error), (null or ?#sending _)) {
          ignore readNote();
          if (mayHaveSent) { notYet(error) } else { keep(#rejected(error)) };
        };
        case (#tryAgain(error), (null or ?#sending _)) { notYet(error) };
        case (#ambiguous(error), (null or ?#sending _)) {
          mayHaveSent := true;
          notYet(error);
        };
        case (_, ?kept) { kept };
      };
    };

    switch (results.get(outboxId)) {
      case null {};
      case (?#sending(startedAt)) {
        firstAttemptAt := startedAt;
        let note = results.get(noteKey(outboxId));
        // A post an older bridge made, whose record of it an upgrade lost, is
        // taken as in flight from the first attempt
        let posted = switch (note) {
          case (?#sending(posted)) { posted };
          case _ { startedAt };
        };
        let error = switch (note) {
          case (?#unknown(error)) {
            mayHaveSent := true;
            error;
          };
          case (?#rejected(error)) { error };
          case _ {
            if (Time.now() - posted < inFlightFor) { return #sending(startedAt) };
            mayHaveSent := true;
            "no outcome within the post window";
          };
        };
        if (Time.now() - startedAt >= postWindow) { return notYet(error) };
      };
      case (?status) { return status };
    };

    for (attachment in request.attachments.values()) {
      if (not isBase64(attachment.base64)) {
        return finish(#notSent(truncate("invalid attachment: " # attachment.filename)));
      };
    };
    let ?config = EmailClient.gatewayConfig<system>() else {
      return finish(#notSent(EmailClient.gatewayNotConfigured));
    };
    let ?#bearer(token) = config.auth else {
      return finish(#notSent("The mail gateway has no API key"));
    };
    let httpRequest = sendRequest(config, token, "relay-" # outboxId, requestBody(request));
    // The management canister would reject it, and such a reject counts as
    // possibly sent. Escaping can make the JSON larger than the email.
    let bytes = requestBytes(httpRequest);
    if (bytes > maxRequestBytes) {
      return finish(#notSent("the email is too large to post: " # bytes.toText() # " bytes"));
    };

    // Recorded before the first await, so a concurrent repeat cannot post too
    let now = Time.now();
    postedAt := ?now;
    results.add(outboxId, #sending(firstAttemptAt));
    results.add(noteKey(outboxId), #sending(now));
    finish(await* post(config, httpRequest, firstAttemptAt));
  };
};
