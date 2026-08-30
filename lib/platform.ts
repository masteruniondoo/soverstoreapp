export function isAndroidUserAgent(userAgent: string): boolean {
  return /Android/i.test(userAgent);
}

export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return isAndroidUserAgent(navigator.userAgent);
}
