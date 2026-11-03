const keyName = "morning.owner-reminder-key";

export function ownerKey(): string {
  try {
    return window.localStorage.getItem(keyName) ?? "";
  } catch {
    return "";
  }
}

// The URL fragment is never sent with the page request. Consume it before
// any links are followed; provider credentials never enter the browser.
export function pairOwnerBrowser() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("reminder-key");
  if (token === null) return;
  history.replaceState(history.state, "", location.pathname + location.search);
  if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    localStorage.setItem(keyName, token);
  }
}

export type MailSchedule = {
  id: string;
  title: string;
  dueAt: string;
  revision: number;
};
