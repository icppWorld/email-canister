# Setting up a domain from a release

A deployment is a small repository of its own. It vendors one email-canister release, and holds only what belongs to that domain: canister ids, the sign-in origin and, if wanted, a brand. It needs `icp`, Node.js 20 or later and, for checks, `curl` and `dig`. It needs no compiler.

```
my-domain-mail/
  scripts/vendor.sh        downloads a release, checks its sha256 and unzips it
  vendor/email-canister/   the unzipped release (build/ and *.wasm kept out of git)
  brand/brand.json         optional, see webmail/README.md in the release
  deploy.env               BACKEND, ORIGIN, NETWORK
  icp.yaml
  build/webmail/           written by brand.mjs, not committed
  build/domain/            written by domain.mjs, only for a brought-in domain (step 6)
  .icp/data/mappings/      the canister ids, committed
```

## 1. Vendor a release

Download `email-canister_vX.Y.Z.zip` from the release page. It holds one folder, `email-canister_vX.Y.Z/`; unpack that folder as `vendor/email-canister`, then check the wasm against the hash in the release title:

```bash
rm -rf vendor/email-canister
unzip -q email-canister_vX.Y.Z.zip -d vendor
mv vendor/email-canister_vX.Y.Z vendor/email-canister
sha256sum vendor/email-canister/build/email-canister.wasm
cat vendor/email-canister/build/email-canister.wasm.sha256
```

To check it independently, rebuild the release's commit with `make docker-build-base docker-build` and compare `out/email-canister.wasm.sha256`.

## 2. Declare the canisters

`icp.yaml` installs the release's wasm as it is, pinned to its hash, and serves the configured webmail from `build/webmail`:

```yaml
canisters:
  - name: email-canister
    recipe:
      type: '@dfinity/prebuilt@v2.0.0'
      configuration:
        path: vendor/email-canister/build/email-canister.wasm
        sha256: <the release's wasm sha256>

  - name: webmail
    recipe:
      type: '@dfinity/asset-canister@v2.3.0'
      configuration:
        version: 0.30.2
        dir: build/webmail
```

Create both canisters on the IC once (a domain registered elsewhere adds a third in step 6), and commit `.icp/data/mappings/` so every later deploy reaches the same ones. The webmail's URL, `https://<webmail id>.icp0.io`, becomes the sign-in origin. Fix it before anyone signs in: Internet Identity gives each user a different principal per origin, so changing it later locks every user out of their mailbox.

## 3. Deploy the backend

```bash
icp deploy email-canister --environment ic
```

To upgrade later, after vendoring the new release and updating the pin, stop the canister first: a snapshot is only safe to restore when no call is in flight, and the upgrade needs it stopped too.

```bash
icp canister stop email-canister --environment ic
icp canister snapshot create email-canister --environment ic
icp canister install email-canister --mode upgrade --environment ic
icp canister start email-canister --environment ic
```

Then check the module hash with `scripts/check.sh`. If anything is wrong, stop the canister and restore the snapshot.

Read the release notes' upgrade notes before upgrading.

## 4. Configure and deploy the webmail

```bash
node vendor/email-canister/webmail/brand.mjs \
  --dist vendor/email-canister/webmail/dist --out build/webmail \
  --backend <backend id> --origin https://<webmail id>.icp0.io --network ic \
  [--brand brand]
icp deploy webmail --environment ic
```

Without `--brand` the webmail is greyscale and called "Mail". The script writes the settings into `index.html` and writes `.well-known/ic-smtp-canister-id`, which names the backend. To have the webmail also answer on an address of your own, such as `mail.example.com`, see step 9.

## 5. Set up the sending side

Sending goes through a Caffeine app on the same domain, with email sending enabled. Add the files in `bridge/` to its backend as `bridge/README.md` describes, with the relay caller set to your backend's id.

Caffeine's email service adds an open-tracking pixel to every message it sends, which reports to the service when a recipient's mail program loads it. That is the service's setting, and a deployment cannot turn it off. Tell your users, if it matters to them.

The SMTP gateway reads `https://<domain>/.well-known/ic-smtp-canister-id` from the bare domain itself, so the bare domain must serve it with your backend's id. For a domain bought through Caffeine, the Caffeine app serves the bare domain: add the file to its site. For a domain registered elsewhere, the domain canister of step 6 serves it.

## 6. Serve the bare domain

Skip this step if the Caffeine app already serves `https://<domain>/.well-known/ic-smtp-canister-id`, as it does for a domain bought through Caffeine. You need it when Caffeine connected `www.<domain>`, which it always does for a domain registered elsewhere: it sets up `www` with a CNAME, which a bare domain cannot hold, and it rewrites its site's `/.well-known/ic-domains` at every deploy to list only `www.<domain>`. The bare domain then answers nowhere, and the gateway cannot find your backend.

The domain canister is a small asset canister you control. On the bare domain it serves the backend's id for the gateway, lists the domain for the IC's custom-domain service, and sends browsers to `https://www.<domain>`, keeping the path, query and fragment; a browser without JavaScript goes to the website's home page.

Declare it in `icp.yaml`, next to the webmail:

```yaml
  - name: domain
    recipe:
      type: '@dfinity/asset-canister@v2.3.0'
      configuration:
        version: 0.30.2
        dir: build/domain
```

Create it on the IC and commit the mapping. About 0.5T cycles is enough. Then write and deploy it:

```bash
node vendor/email-canister/domain/domain.mjs --out build/domain \
  --backend <backend id> --domain example.com [--redirect https://www.example.com]
icp deploy domain --environment ic
```

`--redirect` is the website's origin, `https://www.<domain>` by default.

At the domain's registrar, set these records for the bare domain:

| Record                        | Type          | Value                                                                           |
|-------------------------------|---------------|---------------------------------------------------------------------------------|
| `example.com`                 | ALIAS / ANAME | `icp1.io`, where the registrar offers it                                        |
| `example.com`                 | A and AAAA    | otherwise the addresses of `dig +short A icp1.io` and `dig +short AAAA icp1.io` |
| `_canister-id.example.com`    | TXT           | the domain canister's id                                                        |
| `_acme-challenge.example.com` | CNAME         | `_acme-challenge.example.com.icp2.io`                                           |

Remove older A, AAAA and `_canister-id` records on the bare domain. Leave `www`, which Caffeine set up, as it is. Plain A and AAAA records hold `icp1.io`'s addresses of today, so check them again if `icp1.io` moves.

Then register the domain with the IC's custom-domain service:

```bash
curl -sS https://icp0.io/custom-domains/v1/example.com/validate     # must report success
curl -sS -X POST https://icp0.io/custom-domains/v1/example.com
curl -sS https://icp0.io/custom-domains/v1/example.com              # repeat until "registered"
```

Once it is registered, `https://example.com/.well-known/ic-smtp-canister-id` answers with your backend's id.

## 7. Configure the backend

As a controller of the backend:

```bash
vendor/email-canister/scripts/configure.sh --backend <backend id> --domain example.com \
  --bridge <the Caffeine app's backend id> --identity <controller identity>
```

Then sign in to the webmail as a controller, and in the Admin screen create each mailbox with its first member, the principal that person's "not activated" screen shows. Keep the controller's identity for administration: make it a member of no mailbox, and read mail with another identity: sign in to the webmail with that one, and its "not activated" screen shows the principal to add. A controller can reinstall or delete the canister, so its sign-in should not be the one that opens mail from anyone. Add more members to a mailbox to share it; "How people get their mail" in the Admin screen walks through both.

## 8. Point the domain's mail at the gateway

Set the domain's MX records to the SMTP gateway's, as its documentation lists them. Do this last: from then on, mail for the domain arrives in the canister. Moving a domain from another mail provider means exporting the old mail first.

Then check the whole deployment:

```bash
vendor/email-canister/scripts/check.sh --backend <backend id> --domain example.com \
  --wasm-sha256 <the release's wasm sha256> [--www]
```

`--www` also checks the website on `www.<domain>`.

## 9. Give the webmail a custom domain (optional)

The webmail always answers on `https://<webmail id>.icp0.io`. It can also answer on an address of your own, such as `mail.example.com`, and every user keeps the same principal on both. The principal comes from `--origin`, and Internet Identity accepts a sign-in on another address when the origin lists that address.

Keep `--origin` as it is and add the address to the brand script of step 4, then deploy the webmail again:

```bash
node vendor/email-canister/webmail/brand.mjs \
  --dist vendor/email-canister/webmail/dist --out build/webmail \
  --backend <backend id> --origin https://<webmail id>.icp0.io --network ic \
  [--brand brand] --custom-domain mail.example.com
icp deploy webmail --environment ic
```

The script then also writes `.well-known/ic-domains`, which the IC's custom-domain service reads, and `.well-known/ii-alternative-origins`, which Internet Identity reads from the `--origin` address. That is why `--origin` must be the webmail's own `https://<webmail id>.icp0.io`. Repeat `--custom-domain` for up to 10 addresses.

Never set `--origin` to the custom domain: every user would get a new principal and lose their mailbox.

At the domain's registrar:

| Record                             | Type  | Value                                       |
|------------------------------------|-------|---------------------------------------------|
| `mail.example.com`                 | CNAME | `mail.example.com.icp1.io`                  |
| `_canister-id.mail.example.com`    | TXT   | the webmail canister's id                   |
| `_acme-challenge.mail.example.com` | CNAME | `_acme-challenge.mail.example.com.icp2.io`  |

Then register it, as in step 6:

```bash
curl -sS https://icp0.io/custom-domains/v1/mail.example.com/validate     # must report success
curl -sS -X POST https://icp0.io/custom-domains/v1/mail.example.com
curl -sS https://icp0.io/custom-domains/v1/mail.example.com              # repeat until "registered"
```

Once it is registered, sign in on both addresses as the same user: both open the same mailbox.

## Keeping it running

- Keep cycles on the backend topped up. A canister that runs out of cycles is eventually deleted with its mail.
- Keep cycles on the domain canister too, where you have one: without it the gateway cannot find the backend.
- Keep the domain registered and its MX records in line with the gateway's list.
- Upgrade with each release you want, by its upgrade notes.
