# App-only SoverStore Drop links

SoverStore generates one Drop link format:

```text
soverstore.dot/drop/<dropId>
```

This is a Polkadot Browse address, not a public HTTP URL. A user copies it from
SoverStore, opens Browse in Polkadot Desktop, and pastes it there. SoverStore
deliberately does not use Chrome/Safari handoff, Android intent packages,
app-store redirects, Universal Links, or custom URL schemes.

This format targets Desktop, where Browse preserves the pathname: on load,
`AppRouteContent` resolves `/drop/<dropId>` and `DropEntryRoute` opens the
existing focused Drops interface directly. Wallet, purchase, ownership,
encryption, Bulletin retrieval, and decryption continue to use their existing
authoritative paths.

Mobile Browse does not reliably preserve a pathname (or a `#/drop/<dropId>`
hash fragment) when a link is pasted directly into its address field, so a
pasted link on mobile lands on the SoverStore home screen instead of the Drop.
For mobile, open the Drops page in SoverStore and use **Open a shared Drop** to
enter the link manually. That input accepts the app-only Browse address, the
legacy canonical HTTPS address, the older `#/drop/<dropId>` fragment format, or
the bare numeric Drop ID.

If `/drop/<id>` is opened in an ordinary web browser, the page performs no
wallet connection or transaction. It only displays the app-only address and
instructions to use it in Polkadot Browse.
