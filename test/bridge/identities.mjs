// The principal the test build accepts as the email-canister backend.
// `node identities.mjs` prints it for build.sh.
import { createIdentity } from "@dfinity/pic";

export const relayCaller = createIdentity("relay-caller").getPrincipal();
export const stranger = createIdentity("stranger").getPrincipal();

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(relayCaller.toText());
}
