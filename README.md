# SoverStore — Polkadot Products Devnet

SoverStore is a client-side application for encrypting files locally, storing
the encrypted data on Products Devnet Bulletin, and recovering it with a
private recovery file or QR image.

This repository is a Devnet-only project. It produces a static application
bundle for the Polkadot application gateway and contains no alternative hosting
profile.

## Architecture

- Next.js provides the static browser application.
- AES-256-GCM encryption and decryption happen in the user's browser.
- `@parity/product-sdk` connects the host wallet to Products Devnet Bulletin.
- Only encrypted data is uploaded.
- Recovery JSON and QR artifacts contain the decryption key and must remain
  private.
- The application bundle is published under `soverstore.dot` and served from
  `https://soverstore.dev-dot.li`.

## Project structure

| Path | Purpose |
| --- | --- |
| `app/` | Application pages and global styles |
| `components/` | Shared interface components |
| `lib/` | Encryption, recovery, wallet, and Bulletin integration |
| `public/` | Devnet application icons |
| `next.config.mjs` | Permanent static-export configuration |
| `polkadot-app-deploy.config.ts` | Polkadot app name, icon, version, and bundle path |
| `DEVNET.md` | Account preparation, publishing, and verification procedure |
| `out/` | Generated publishable bundle; not committed |

## Local development

Requirements:

- Node.js 22 or newer
- npm

Install dependencies and start the development server:

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The application expects the wallet interface
provided by the Polkadot Products host; functionality may be limited in a
normal browser tab.

## Build

```bash
npm run build
```

Every production build is a Devnet static export. The publishable result is
written to `out/` and must include:

- `out/index.html`
- `out/recovery/index.html`
- `out/preview/index.html`

## Public build configuration

These optional variables are embedded in the browser bundle at build time:

| Variable | Default |
| --- | --- |
| `NEXT_PUBLIC_APP_ORIGIN` | `https://soverstore.dev-dot.li` |
| `NEXT_PUBLIC_BULLETIN_NETWORK_NAME` | `Products Devnet Bulletin` |
| `NEXT_PUBLIC_BULLETIN_NETWORK_ID` | `devnet-bulletin` |
| `NEXT_PUBLIC_BULLETIN_IPFS_GATEWAY` | `https://devnet-ipfs.api.polkadotcommunity.foundation` |

Do not store a mnemonic, private key, password, or other secret in this
repository or in a `NEXT_PUBLIC_*` variable. All `NEXT_PUBLIC_*` values are
visible to application users.

See [DEVNET.md](DEVNET.md) for the complete publishing procedure.

## License

SoverStore is available under the [MIT License](LICENSE).
