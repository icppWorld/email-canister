import Cycles "mo:core/Cycles";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
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

  /// What is known about the attempts to send an email that is still
  /// `#sending`. It lives in transient memory: no call is in flight across an
  /// upgrade, and a record lost in one counts as "may have been sent".
  public type Attempt = {
    /// An attempt is in flight; a repeated call must not post again.
    #inFlight;
    /// The last attempt ended without a final outcome; the next call posts again.
    #ended : { error : Text; mayHaveSent : Bool };
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

  let hexDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

  /// The backend's outbox_encoded_size counts the bytes this escaping adds,
  /// so it refuses a message too large to post: change the two together.
  func jsonString(value : Text) : Text {
    var out = "\"";
    for (c in value.chars()) {
      out #= switch (c) {
        case '\"' { "\\\"" };
        case '\\' { "\\\\" };
        case '\n' { "\\n" };
        case '\r' { "\\r" };
        case '\t' { "\\t" };
        case _ {
          if (c < ' ') {
            let code = c.toNat32().toNat();
            "\\u00" # hexDigits[code / 16].toText() # hexDigits[code % 16].toText();
          } else { c.toText() };
        };
      };
    };
    out # "\"";
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
    var size = 0;
    var padding = 0;
    for (c in text.chars()) {
      if (c == '=') {
        padding += 1;
      } else if (padding > 0) {
        return false;
      } else if (not ((c >= 'A' and c <= 'Z') or (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9') or c == '+' or c == '/')) {
        return false;
      };
      size += 1;
    };
    size % 4 == 0 and padding <= 2;
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

  func sendRequest(config : Config, token : Text, key : Text, body : Blob) : _Ic.HttpRequestArgs {
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

  /// A lost response is retried once with the same key, so the gateway replays
  /// its stored response instead of sending a second time. Not after the post
  /// window, where the retry could reach the gateway after its record expired.
  func post(config : Config, request : _Ic.HttpRequestArgs, firstAttemptAt : Int) : async* Outcome {
    // Never more than the balance: a Caffeine engine reports a balance of 0
    // and pays for the outcall itself
    let cycles = Nat.min(_Helpers.outcallFee(request, config.pricing_version), Cycles.balance());
    func postOnce() : async* Outcome {
      httpOutcome(await (with cycles) _Ic.http_request(request));
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

  /// Send an email, or report what happened to the one with the same outboxId.
  ///
  /// `#sent`, `#rejected` and `#unknown` are kept under the outboxId and
  /// repeated: the backend takes them as final, and a call that overlaps
  /// another for the same email must not post it again. Any other outcome is
  /// retried within the post window with the same idempotency key, one post
  /// per call.
  public func send(
    results : Map.Map<Text, Types.RelayStatus>,
    attempts : Map.Map<Text, Attempt>,
    request : Types.RelayRequest,
  ) : async* Types.RelayStatus {
    let outboxId = request.outboxId;
    if (outboxId.size() == 0 or outboxId.size() > maxOutboxIdSize) {
      return #rejected("invalid outboxId");
    };

    // What the earlier calls for this email left
    var firstAttemptAt = Time.now();
    var mayHaveSent = false;

    func keep(status : Types.RelayStatus) : Types.RelayStatus {
      attempts.remove(outboxId);
      results.add(outboxId, status);
      status;
    };

    // No final outcome yet. Within the post window the next call posts
    // again; after it, a new post could send a second time, so it stops.
    func notYet(error : Text) : Types.RelayStatus {
      if (Time.now() - firstAttemptAt < postWindow) {
        attempts.add(outboxId, #ended({ error; mayHaveSent }));
        return #sending(firstAttemptAt);
      };
      // No attempt reached the gateway, or it refused to take them on
      keep(if (mayHaveSent) { #unknown(error) } else { #rejected(error) });
    };

    // Records the outcome of this call's attempt. While it is in flight,
    // another call keeps no result but #unknown, after the post window
    // (outcall timeouts make that practically unreachable); an upgrade ends
    // every attempt in flight. The backend took the #unknown as final, but a
    // late #sent or #rejected is the truth and corrects it.
    func finish(outcome : Outcome) : Types.RelayStatus {
      switch (results.get(outboxId), outcome) {
        case (?#unknown _, #sent) {};
        case (?#unknown(error), _) {
          if (mayHaveSent) { return keep(#unknown(error)) };
        };
        case _ {};
      };
      switch (outcome) {
        case (#sent) { keep(#sent) };
        // Not sent by this attempt; an earlier one still may have
        case (#notSent(error)) {
          if (mayHaveSent) { notYet(error) } else { keep(#rejected(error)) };
        };
        case (#tryAgain(error)) { notYet(error) };
        case (#ambiguous(error)) {
          mayHaveSent := true;
          notYet(error);
        };
      };
    };

    switch (results.get(outboxId)) {
      case null {};
      case (?#sending(startedAt)) {
        firstAttemptAt := startedAt;
        let inWindow = Time.now() - startedAt < postWindow;
        switch (attempts.get(outboxId)) {
          case (?#inFlight) {
            if (inWindow) { return #sending(startedAt) };
            mayHaveSent := true;
            return notYet("no outcome within the post window");
          };
          case (?#ended(ended)) {
            mayHaveSent := ended.mayHaveSent;
            if (not inWindow) { return notYet(ended.error) };
          };
          // Lost in an upgrade
          case null {
            mayHaveSent := true;
            if (not inWindow) { return notYet("no outcome within the post window") };
          };
        };
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
    results.add(outboxId, #sending(firstAttemptAt));
    attempts.add(outboxId, #inFlight);
    finish(await* post(config, httpRequest, firstAttemptAt));
  };
};
