/** `5Gv1zL…Qd8K` style truncation for SS58 addresses. */
export function shortAddress(address: string, edge = 6): string {
  if (address.length <= edge * 2 + 1) return address;
  return `${address.slice(0, edge)}…${address.slice(-edge)}`;
}

/** Human-readable byte counts: 10 MB, 512 KB, 96 B. */
export function formatBytes(bytes: bigint): string {
  const mb = 1024n * 1024n;
  if (bytes >= mb) {
    const whole = bytes / mb;
    const tenth = ((bytes % mb) * 10n) / mb;
    return tenth === 0n ? `${whole} MB` : `${whole}.${tenth} MB`;
  }
  if (bytes >= 1024n) return `${bytes / 1024n} KB`;
  return `${bytes} B`;
}

export function formatNumber(value: bigint | number): string {
  return new Intl.NumberFormat("en-US").format(
    typeof value === "bigint" ? value : Math.trunc(value),
  );
}
