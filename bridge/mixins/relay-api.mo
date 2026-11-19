import Map "mo:core/Map";
import Runtime "mo:core/Runtime";
import Types "../types/relay";
import RelayLib "../lib/relay";

mixin (relayResults : Map.Map<Text, Types.RelayStatus>) {
  /// Where the next call starts looking for results to remove. Transient: a
  /// value lost in an upgrade only starts the sweep over.
  transient var relaySweepFrom = "";

  /// Send an email from the domain on behalf of the email-canister backend. A
  /// repeated call with the same outboxId never sends it twice: it reports the
  /// outcome, or tries again while that is still safe.
  public shared ({ caller }) func relaySend(request : Types.RelayRequest) : async Types.RelayStatus {
    if (not RelayLib.isRelayCaller(caller)) {
      Runtime.trap("Unauthorized: only the email-canister backend can relay email");
    };
    relaySweepFrom := RelayLib.sweep(relayResults, relaySweepFrom);
    await* RelayLib.send(relayResults, request);
  };
};
