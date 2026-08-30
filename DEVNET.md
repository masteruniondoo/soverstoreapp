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

## Private Drops Phase 0 probe

Observed on 2026-07-31 through the deployed SoverStore Product, using the host
`SignerManager` and `@parity/product-sdk/contracts` path that the Drops `buy`
transaction will use.

Probe contract:

- Package: `@soverstore/probe`, version `0`
- Address: `0x789F5Ff048d32750893DE60E5c74d7562F813a9d`
- Transaction: `0x88a7b5bdbf857b5d7ad2ef66800c5e35ce3059b7230e4d370bcf7f393f743a3f`

| Reading | Observed value | Conclusion |
| --- | --- | --- |
| SDK transaction value | `10^10` | The contract client submits one native PAS using the Asset Hub 10-decimal unit. |
| Solidity `msg.value` | `10^18` | `pallet-revive` normalizes one PAS to one EVM ether. Contract prices use `10^18` units per PAS. |
| Native-to-contract factor | `10^8` | Convert a contract price to the SDK transaction value by dividing by `10^8`. |
| Host SS58 | `5CMPRVBj75pZapyrrQHoft6WZsFyk5dAesGHW15wj1SgKcK3` | This app-scoped Product account is the account that actually signs. |
| Derived EVM | `0xaedc9d742b5b124583dc5bfaa07c6d69dc2b5938` | This is the address used by `buyersOf`, `encKeyOf`, and `envelopeOf`. |
| Event sender | `0xaedc9d742b5b124583dc5bfaa07c6d69dc2b5938` | The event sender matches the EVM address derived from the host SS58 account. |
| Sender balance | `4998990000000000000000` | The signing account is funded; the value is normalized to 18 decimals in Solidity. |
| Block timestamp | `1785530460` | Sane: 43 seconds behind the observed local timestamp `1785530503`. |

The host SS58 and event EVM addresses are two representations of the same
funded, app-scoped Product account. Faucet requests for Drops must target the
SS58 address above on Paseo Asset Hub para `1000`, while contract buyer lookups
must use the derived EVM address above.

## Private Drops Phase 1 contract

Deployed to Products Devnet on 2026-07-31:

- Package: `@soverstore/drops`, version `0`
- Address: `0x6E084A5d49ac47538bDdcb169Bea5A5E67BC4EdC`
- Metadata CID: `bafk2bzaceajl42fx2qhlbyuxbgtduvolfes4wzz7zwet4iqfrpru35lk357zk`
- Deploy/register transaction:
  `0x372e9ddaca2824d1ddfc114198730913f7a2adb73e20e545afbe6c7ab8c1a356`
- Contract owner: `0xaEDC9d742B5b124583DC5BfAa07c6D69dc2B5938`

The supplied no-argument contract originally assigned `msg.sender` as owner.
CDM 0.8.26 deploys with no constructor data and signs with its separate tooling
account, while Phase 0 proved that owner transactions inside SoverStore are
signed by the app-scoped Product account above. With explicit project-owner
approval, the constructor therefore assigns that observed Product EVM address
directly; the rest of the delivered contract is unchanged.

Manual function/revert exercise through the Product host signer completed on
2026-07-31 using the temporary Phase 1 panel at `/probe/`:

- `owner`, `dropCount`, `dropInfo`, `buyersOf`, `buyerKeys`, `isBuyer`,
  `encKeyOf`, and `envelopeOf` returned the expected values.
- Two drops were created with the same open sale window, confirming independent
  simultaneous drops. Create transactions included
  `0x64849940676efb8f3d3a0426cf8b2469647c8db4bd87bf9c527d9b3caac9254c`
  and `0x175eb6519ffd39bd7656066fea36e0e65f976512bbaeb58a78bbbc1be7b90158`.
- `buy` rejected underpayment, malformed key length, malformed key prefix, a
  duplicate purchase, and a purchase after the deadline. A 2 PAS overpayment
  succeeded and was retained by the contract.
- `addEnvelopes` rejected calls before the deadline, mismatched arrays, a
  non-buyer address, and calls after publication. A valid 125-byte envelope was
  stored, then cleanly overwritten by a second envelope.
- `publish` rejected calls before the deadline and a second publication. The
  valid publication finalized with CID `phase1-contract-check`; transaction
  `0xe29b7e9ce531ccf333bc3d23955a8121fd2116b6804bd930b3d11e029c5b9bdd`.
- `withdraw` initially exposed that product-sdk-contracts 0.9.2 submits the
  exact dry-run weight without a safety margin. Retrying with a two-times gas
  weight (`ref_time` estimate `600280604`, `proof_size` estimate `59691`)
  finalized successfully in transaction
  `0x55b0e78665d72acd3b7eff632710d474165a476fdd09c00f64c83cf84f8a6b2b`.

Phase 1 exit criteria are complete. The temporary `/probe/` panel, Probe
navigation entry, and `contracts/Probe.sol` were removed before shipping.

## Private Drops application verification

The owner create/buy/publish flow was verified in the real Polkadot Product host
on 2026-08-01 with the paired mobile signer and a one-buyer drop:

- Deployed application bundle CID:
  `bafybeigxotspyn7h4aozajyojofdtxb6gaaiqvwbvbbvdy2kdx5v6zuboa`
- Application content-link transaction:
  `0x966c4c8708f1800a892bf5bbfa15a404d5e4c636afed2ea0a22b769e57d1e2c2`
- Content link finalized at block `11673490`.
- Drop creation transaction:
  `0x422eeb383cfdd5c66025219878ff7014c894648a8fcf03b58755155dd95652de`
- Published Bulletin CID:
  `bafykbzacecakx4pcnobla7ltshjrzwq6lzevf2i3y2oqwmdo3jj4qzgczg5gu`

The buyer purchase and final publish both finalized through native signing, but
their transaction hashes were not retained in the test handoff. The selected
GIF was encrypted and uploaded after a transient 10-second allowance-read
timeout; retrying the pre-upload check succeeded. The published file then
decrypted, previewed, and saved successfully from the buyer device.

A zero-buyer publication was also verified in the Product host:

- Drop creation transaction:
  `0xaf453d8a74b8ab0c0b57b0d6633e6103c235d844d002888d665b77d450030cc6`
- Published Bulletin CID:
  `bafykbzaceccsi4kb3kw7tbjqajyvuctufi4a4ckb63zwj4tfvo5zpchajad7s`

The owner, who was not a buyer of that drop, pressed **Open file**. The app
downloaded the complete public blob and reported the expected AES-GCM
authentication failure without implying any server-side access gate. This
explicitly verifies both zero-buyer publication and the non-buyer Open path.

Release `0.1.34` validation coverage:

- Completed: production type/lint/build checks; static exports for Storage,
  Recovery, Preview, About, and Drops; phase-0 identity/denomination checks;
  the full phase-1 contract checklist; cryptographic round-trip/failure checks;
  missing-local-key rendering; one-buyer create/buy/publish/open/save; zero-buyer
  publish; and the explicit non-buyer download/decryption-failure path.
- Not exercised in the final Product-host pass: a three-buyer publication, more
  than 20 buyers across multiple envelope transactions, and a fresh manual
  legacy Storage save-and-recover cycle. Finalization proceeded with project
  owner approval after the covered runtime paths passed.

Final release deployment completed on 2026-08-01. The executable manifest was
verified on-chain as `{"$v":1,"kind":"app","appVersion":[0,1,34]}` in
transaction
`0xc9f3619568d0caa4c5ac54898a9069af880c9152c2128171e545806c378ef479`.

Release `0.1.73` deployment completed on 2026-08-30. This release fully
automates Bulletin authorization after wallet connect (automatic
lookup/authorize/confirm against the same devnet `//Eve` faucet mechanism the
Bulletin Console uses, with every manual "Request Bulletin allowance" button
removed). Published application bundle CID:
`bafk2bzacecaualxn2p2c7lfj2vqhvv4qdxqphz6xjhgwf6ubswhsi5raw2wuu`. Content-link
transaction:
`0x8d88539716bc5b4a5f5e2b019aaf04b20c0e3e9dbf93e26082d469b4e7e18c57`.

### Drops operating procedure

1. Open `Drops` in the deployed Product and connect the app-scoped owner wallet.
2. Create a drop with a public announcement name, PAS price, and a future local
   deadline. The actual file name remains inside the encrypted PRFY1 payload.
3. Before the deadline, buyers press **Buy access**, acknowledge that the local
   encryption key is device-bound, and approve the native signing request.
4. The owner panel continuously shows the on-chain Bulletin transaction quota,
   byte quota, and expiry. A full page refresh is not required after allocation.
5. If the panel reports missing, expired, exhausted, or insufficient storage,
   press **Request Bulletin allowance** and wait until the application itself
   reports **Bulletin ready**. After the deadline, select one file and press
   **Publish file**.
6. Approve the Bulletin upload (and each chunk for a larger file), each envelope
   batch, and the final publish
   transaction. Do not reload after upload while envelope or publish work is in
   progress: the content key is intentionally held only in memory.
7. If a post-upload transaction fails, retain the displayed CID and use
   **Retry envelopes / publish**. This resumes from the CID without uploading
   the encrypted blob again.
8. Once published, use **Open file** and **Save / share document** to verify the
   buyer path. A non-buyer can fetch the public ciphertext but cannot decrypt it.

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

The displayed deployment account requires:

1. PAS on Paseo Asset Hub (para 1000) for fees.
2. An EVM mapping:

   ```bash
   dotns account map --env devnet
   ```

Bulletin storage authorization is separate from this deployment account. At
runtime the Product host allocates it to the app-scoped `soverstore.dot`
account; Storage and Drops then track its on-chain quota and expiry
automatically.

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
pad.cmd ./out soverstore.dot --env devnet --mnemonic $env:MNEMONIC --config ./polkadot-app-deploy.config.ts
```

The `--env devnet` option is mandatory. Publishing the application bundle does
not publish user files; user files are encrypted locally and stored separately
on Products Devnet Bulletin.

Optional Browse listing, which may require proof of personhood:

```powershell
pad.cmd ./out soverstore.dot --env devnet --mnemonic $env:MNEMONIC --config ./polkadot-app-deploy.config.ts --publish
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
