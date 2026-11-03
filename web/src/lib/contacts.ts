export type Contact = { id: string; name: string; email: string };
export type GuestContact = Contact & { sample?: boolean };
export type ContactOption = { contact_id: string; name: string; email: string };

// This small guest address book is intentionally available to live commands.
// The UI labels these reserved example addresses; no address is a real mailbox.
export const EXAMPLE_CONTACTS: GuestContact[] = [
  {
    id: "sample-priya-shah",
    name: "Priya Shah",
    email: "priya.shah@example.com",
    sample: true,
  },
  {
    id: "sample-alex-chen",
    name: "Alex Chen",
    email: "alex.chen@example.com",
    sample: true,
  },
];

export function validateContact(name: string, email: string) {
  if (
    !name.trim() ||
    [...name.trim()].length > 200 ||
    !/[\p{L}\p{N}]/u.test(name)
  )
    throw new Error("Enter a name of up to 200 characters.");
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/.test(email))
    throw new Error("Enter a plain email address, such as priya@example.com.");
}

function words(value: string) {
  return value.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

export function relevantContacts(
  contacts: readonly Contact[],
  transcript: string,
): Contact[] {
  const spoken = new Set(words(transcript));
  return contacts
    .filter((contact) => words(contact.name).some((word) => spoken.has(word)))
    .slice(0, 20)
    .map(({ id, name, email }) => ({ id, name, email }));
}
