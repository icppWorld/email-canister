# Configuring a deployment's webmail

The webmail is built once, and the same build serves every deployment. `brand.mjs` turns that build into one deployment's webmail. It needs only Node.js 20 or later, with no npm install:

```bash
node brand.mjs --dist <webmail build> --out <folder to deploy> \
  --backend <backend canister id> --origin https://<webmail canister id>.icp0.io \
  [--network ic|local] [--brand <brand folder>] [--custom-domain <host>]...
```

- `--backend` names the canister the webmail calls. The script also writes it to `.well-known/ic-smtp-canister-id`, which the SMTP gateway reads to find the canister that receives the domain's mail.
- `--origin` is the Internet Identity derivation origin. Every user's principal depends on it, so set it before the first user is added and never change it. It is required on `ic`.
- `--custom-domain` is another address the webmail answers on, such as `mail.example.com`, with the same principals, because they still come from `--origin`. The script writes `.well-known/ic-domains` for the IC's custom-domain service and `.well-known/ii-alternative-origins` for Internet Identity. Repeat it for up to 10 addresses. It needs `--origin`, and must not be a canister address such as `<id>.icp0.io`. Internet Identity reads the list from the `--origin` host, so `--origin` must be this webmail's own address, `https://<webmail canister id>.icp0.io` (or `.ic0.app`), not the backend's; the script refuses any other. The release's `docs/setup-guide.md` lists the DNS records and the registration.
- `--network` is `ic` (the default) or `local` for a local replica.
- `--brand` gives the deployment its company's look. Without it the webmail is greyscale, as set in `default.json`.
- `--out` must be a new or empty folder, or the script's own earlier output, which it replaces.

The script writes these settings into `index.html` as a JSON block, which the browser never runs; the webmail reads it at start-up. A build deployed without the script shows "This webmail is not configured".

For development, `npm run dev` applies the same settings from the variables `WEBMAIL_BACKEND`, `WEBMAIL_NETWORK`, `WEBMAIL_ORIGIN` and `WEBMAIL_BRAND` (a folder relative to `webmail/`), set in the shell or in `webmail/.env.local`.

## The brand folder

The folder holds `brand.json` and the files it names. Every field is optional:

```json
{
  "name": "mail-example",
  "label": "Mail",
  "tagline": "Your email, in a canister you own.",
  "logo": {
    "light": "logo-on-light.svg",
    "dark": "logo-on-dark.svg",
    "alt": "Example"
  },
  "icons": [
    { "file": "favicon.svg", "sizes": "any" },
    { "file": "favicon-32.png", "sizes": "32x32" }
  ],
  "appleTouch": "apple-touch-icon-180.png",
  "fonts": [
    {
      "family": "Example Sans",
      "file": "fonts/ExampleSans.woff2",
      "weight": "400 700"
    }
  ],
  "families": {
    "heading": "\"Example Sans\", Arial, sans-serif",
    "body": "\"Example Sans\", Arial, sans-serif"
  },
  "tokens": "tokens.json",
  "roles": {
    "action": "{brand-700}",
    "selected": { "light": "#eef4ff", "dark": "#1b2a44" }
  }
}
```

- `name` is the browser tab's title. `label` is shown beside the logo and on the sign-in page, and defaults to `name`.
- `logo.dark` is shown when the system is in dark mode. Logos can be SVG, PNG, JPG or WebP. Icons can be SVG, PNG or ICO, and fonts WOFF2 or WOFF.
- `tokens` names a token file in the design-system format: `color.themes` with `light` and `dark`, and lists of `{ "name", "value" }` under `color`, `radius`, `shadow` and so on. A value is a string or `{ "light", "dark" }`.
- `roles` sets the webmail's own variables. A value is a literal, `{ "light", "dark" }`, or `"{token}"` for a token in the tokens file. Roles left out keep their greyscale default. `default.json` lists every role.
- `families` values are CSS font lists, or `"{name}"` for a family listed under `type.families` in the tokens file.
- A brand with no dark theme stays light in dark mode.
- `package` points, relative to `brand.json`, at a brand folder shared with other apps. The files, the tokens file and `manifest.json` are then read from that folder, and the deployment's folder holds only `brand.json`.

## Keeping one source of truth

If the folder holds a `manifest.json`, the script checks every file the brand uses against its sha256 and stops on a difference. Use this when the files are copied from somewhere else, such as a design-system artifact. Refresh the copy from that source rather than editing it:

```json
{
  "source": "where the files come from",
  "version": "…",
  "files": { "tokens.json": "<sha256>" }
}
```

`brand.json` itself is not listed, because it holds this deployment's settings rather than copied brand files.

Role values must be colours, lengths or shadows: letters, digits, `#%.,()/*_+-` and whitespace, with round brackets closed and no CSS comment. Font families must be a comma-separated list of names, in quotes or bare; a bare name is CSS identifiers, so quote one with a digit-led or dotted word, such as `"Source Sans 3"`. The script refuses anything else, because these values go into style sheets.

The script also warns when a text colour and its background fall below 4.5:1 contrast, or a control outline or focus ring below 3:1. Plain mail is shown as `ink` on `surface-raised`, with links in `action`, so those pairs are checked as well.
