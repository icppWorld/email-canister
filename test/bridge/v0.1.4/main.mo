// A Caffeine-style app that includes the bridge as bridge/README.md step 5
// shows, plus two methods for the tests.
import Map "mo:core/Map";
import Prim "mo:⛔";
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

  /// Stores a result as an earlier version of the bridge kept it.
  public func keepResult(outboxId : Text, status : RelayTypes.RelayStatus) : async () {
    relayResults.add(outboxId, status);
  };
};
