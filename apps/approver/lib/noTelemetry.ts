/**
 * The MetaMask Smart Accounts Kit sends usage analytics to MetaMask (mm-sdk-analytics.api.cx.metamask.io) unless
 * Do-Not-Track is set. cyphos-guard doesn't share its users' activity with third parties: signal DNT before the kit
 * runs. (The Content Security Policy also blocks the endpoint, as a second line of defense.)
 */
if (typeof window !== "undefined") {
  try {
    Object.defineProperty(window, "doNotTrack", { value: "1", configurable: true });
  } catch {
    // read-only in this browser: the CSP still blocks the request
  }
}

export {};
