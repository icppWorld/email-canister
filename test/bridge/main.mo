// A Caffeine-style app that includes the bridge as bridge/README.md step 5
// shows, plus methods for the tests.
import Map "mo:core/Map";
import VarArray "mo:core/VarArray";
import Prim "mo:⛔";
import EmailClient "mo:caffeineai-email/emailClient";
import RelayTypes "types/relay";
import RelayApi "mixins/relay-api";
import RelayLib "lib/relay";

actor {
  let relayResults = Map.empty<Text, RelayTypes.RelayStatus>();
  include RelayApi(relayResults);

  /// Whether `text` passes the bridge's base64 check, and the instructions the
  /// check took.
  public func base64Check(text : Text) : async (Bool, Nat64) {
    let start = Prim.performanceCounter(0);
    let valid = RelayLib.isBase64(text);
    (valid, Prim.performanceCounter(0) - start);
  };

  /// `text` as the bridge writes it into JSON, and the instructions that took.
  public func jsonString(text : Text) : async (Text, Nat64) {
    let start = Prim.performanceCounter(0);
    let json = RelayLib.jsonString(text);
    (json, Prim.performanceCounter(0) - start);
  };

  /// The cycles the bridge attaches to a post of a body of this many bytes,
  /// and those the mail client would attach instead.
  public func postFee(bodyBytes : Nat) : async (Nat, ?Nat) {
    let ?config = EmailClient.gatewayConfig<system>() else return (0, null);
    let body = VarArray.repeat<Nat8>(0x20, bodyBytes).toBlob();
    (RelayLib.outcallCycles(config, RelayLib.sendRequest(config, "token", "relay-key", body)), config.cycles);
  };

  /// Stores a result as an earlier version of the bridge kept it.
  public func keepResult(outboxId : Text, status : RelayTypes.RelayStatus) : async () {
    relayResults.add(outboxId, status);
  };

  /// Every key the results map holds.
  public query func resultKeys() : async [Text] {
    relayResults.keys().toArray();
  };
};
