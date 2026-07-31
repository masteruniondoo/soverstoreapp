# Devnet build and deployment

This document is the operational procedure for publishing SoverStore to
Polkadot Products Devnet.

## Deployment identity

- Domain: `soverstore.dot`
- Gateway: `https://soverstore.dev-dot.li`
- Bundle directory: `out/`
- Bulletin chain: Products Devnet Bulletin
- Default IPFS gateway:
  `https://devnet-ipfs.api.polkadotcommunity.foundation`

The domain and executable version are declared in
`polkadot-app-deploy.config.ts`. Update the executable version before publishing
a new application release.

## 1. Install tools

Node.js 22 or newer is required.

```bash
npm install -g @polkadot-community-foundation/dotns-cli
npm install -g @polkadot-community-foundation/polkadot-app-deploy
```

SoverStore does not deploy a smart contract, so `cdm` is not required.

## 2. Prepare a dedicated account

Use a dedicated Devnet account. `dotns` and `pad` use separate credential
inputs, so explicitly provide the same mnemonic to both tools.

In a private PowerShell session:

```powershell
$globalModules = npm.cmd root -g
$env:NODE_PATH = Join-Path $globalModules "@polkadot-community-foundation\dotns-cli\node_modules"
$env:MNEMONIC = node -e "const c=require('@polkadot/util-crypto');c.cryptoWaitReady().then(()=>process.stdout.write(c.mnemonicGenerate()))"
$env:DOTNS_MNEMONIC = $env:MNEMONIC
dotns account address
```

Save the mnemonic in a password manager. Never print it in logs, paste it into
chat, or save it in this project.

The displayed account requires:

1. PAS on Paseo Asset Hub (para 1000) for fees.
2. An EVM mapping:

   ```bash
   dotns account map --env devnet
   ```

3. An active Products Devnet Bulletin storage authorization.

Confirm the name and owner:

```bash
dotns lookup name soverstore --env devnet
dotns lookup owner-of soverstore --env devnet
```

If the name has not been registered:

```bash
dotns register domain --name soverstore --env devnet
```

Never run a write command while `DOTNS_MNEMONIC` is unset. The CLI may otherwise
fall back to a shared development account.

## 3. Install and build

```bash
npm ci
npm run build
```

Verify that the static export exists:

```powershell
Test-Path .\out\index.html
Test-Path .\out\recovery\index.html
Test-Path .\out\preview\index.html
```

All three commands must return `True`.

## 4. Publish

Use the account that owns `soverstore.dot`:

```powershell
pad ./out soverstore.dot --env devnet --mnemonic $env:MNEMONIC --config ./polkadot-app-deploy.config.ts
```

The `--env devnet` option is mandatory. Publishing the application bundle does
not publish user files; user files are encrypted locally and stored separately
on Products Devnet Bulletin.

Optional Browse listing, which may require proof of personhood:

```powershell
pad ./out soverstore.dot --env devnet --mnemonic $env:MNEMONIC --config ./polkadot-app-deploy.config.ts --publish
```

Failure of the optional listing step does not invalidate a successful
application deployment.

Clear secrets from the shell after publishing:

```powershell
Remove-Item Env:MNEMONIC
Remove-Item Env:DOTNS_MNEMONIC
```

## 5. Verify

Inspect the on-chain content binding:

```bash
dotns content view soverstore --env devnet
```

Open and test:

- `https://soverstore.dev-dot.li`
- `https://soverstore.dev-dot.li/recovery/`
- `https://soverstore.dev-dot.li/preview/`

Verification checklist:

1. The host wallet connects.
2. The application reports Products Devnet Bulletin.
3. An authorized account can upload a small encrypted file.
4. The generated JSON recovery file restores the original file.
5. The generated QR recovery image opens the Devnet recovery route and restores
   the original file.

## Endpoint overrides

The browser bundle may override its public IPFS gateway at build time:

```powershell
$env:NEXT_PUBLIC_BULLETIN_IPFS_GATEWAY = "https://example.invalid"
npm.cmd run build
Remove-Item Env:NEXT_PUBLIC_BULLETIN_IPFS_GATEWAY
```

Only use a verified Products Devnet endpoint. Public build variables are not
secret.
