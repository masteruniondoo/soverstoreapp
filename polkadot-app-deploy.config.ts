const deployConfig = {
  domain: "soverstore.dot",
  displayName: "SoverStore",
  description:
    "Encrypt files locally, store ciphertext on Polkadot Bulletin, and recover them privately.",
  icon: { path: "./public/soverstore-icon.png", format: "png" },
  executables: [{ kind: "app", path: "./out", appVersion: [0, 1, 79] }],
};

export default deployConfig;
