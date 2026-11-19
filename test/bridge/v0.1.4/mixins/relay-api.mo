import Map "mo:core/Map";
import Runtime "mo:core/Runtime";
import Types "../types/relay";
import RelayLib "../lib/relay";

mixin (relayResults : Map.Map<Text, Types.RelayStatus>) {
  /// The attempts in flight or to retry. Transient: no call is in flight across
  /// an upgrade, so the actor keeps nothing of it and needs no migration.
  transient let relayAttempts = Map.empty<Text, RelayLib.Attempt>();

  /// Send an email from the domain on behalf of the email-canister backend. A
  /// repeated call with the same outboxId never sends it twice: it reports the
  /// outcome, or tries again while that is still safe.
  public shared ({ caller }) func relaySend(request : Types.RelayRequest) : async Types.RelayStatus {
    if (not RelayLib.isRelayCaller(caller)) {
      Runtime.trap("Unauthorized: only the email-canister backend can relay email");
    };
    await* RelayLib.send(relayResults, relayAttempts, request);
  };
};
