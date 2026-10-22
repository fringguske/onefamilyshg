import "server-only";
import { isCents } from "./money";
import { HttpError, text } from "./server";

/** Validates member fields from a request body. */
export function memberFields(body: Record<string, unknown>, isNew: boolean) {
  const out: Record<string, unknown> = {};
  if (isNew || "full_name" in body) {
    const name = text(body.full_name, 120);
    if (!name) throw new HttpError(400, "Enter the member's full name.");
    out.full_name = name;
  }
  if (isNew || "phone" in body) {
    const phone = text(body.phone, 30);
    if (phone && !/^[+\d][\d\s-]{5,}$/.test(phone)) throw new HttpError(400, "The phone number does not look right.");
    out.phone = phone;
  }
  if (isNew || "national_id" in body) out.national_id = text(body.national_id, 30);
  if (isNew || "notes" in body) out.notes = text(body.notes, 500);
  if (isNew || "joined_on" in body) {
    const d = String(body.joined_on ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new HttpError(400, "Enter a valid date joined.");
    out.joined_on = d;
  }
  if (isNew || "registration_fee_cents" in body) {
    if (!isCents(body.registration_fee_cents)) throw new HttpError(400, "Enter a valid registration fee.");
    out.registration_fee_cents = body.registration_fee_cents;
  }
  if ("status" in body) {
    if (body.status !== "active" && body.status !== "inactive") throw new HttpError(400, "Invalid status.");
    out.status = body.status;
  }
  return out;
}
