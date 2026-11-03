import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GuestContact } from "@/lib/contacts";

type Props = {
  open: boolean;
  contacts: GuestContact[];
  pendingClarification: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (name: string, email: string) => Promise<GuestContact>;
  onRestoreFocus: () => void;
};

export function ContactsDialog({
  open,
  contacts,
  pendingClarification,
  onOpenChange,
  onAdd,
  onRestoreFocus,
}: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      await onAdd(name, email);
      setName("");
      setEmail("");
      setStatus(
        pendingClarification
          ? "Contact saved. Record the complete command again."
          : "Contact saved.",
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save the contact. Please retry.",
      );
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="contacts-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogTitle>Contacts</DialogTitle>
        <DialogDescription>
          Saved in this browser. Example addresses are labeled.
        </DialogDescription>
        <ul className="contacts-list">
          {contacts.map((contact) => (
            <li key={contact.id}>
              <div>
                <span>{contact.name}</span>
                {contact.sample ? (
                  <span className="contact-example">Example</span>
                ) : null}
              </div>
              <p>{contact.email}</p>
            </li>
          ))}
        </ul>
        <form onSubmit={save} className="contact-form">
          <div className="field">
            <Label htmlFor="contact-name">Name</Label>
            <Input
              id="contact-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
              disabled={saving}
            />
          </div>
          <div className="field">
            <Label htmlFor="contact-email">Email</Label>
            <Input
              id="contact-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
              disabled={saving}
            />
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save contact"}
          </Button>
          {error ? (
            <p role="alert" className="action-error">
              {error}
            </p>
          ) : null}
          <p role="status" className="contact-status">
            {status}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
