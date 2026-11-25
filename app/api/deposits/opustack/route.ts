import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/supabase";
import { adapterFor, settledAmount } from "@/lib/gateways";
import { applyDepositCredit } from "@/lib/money";

export const dynamic = "force-dynamic";

/**
 * OpusTack Pay webhook and browser return, at /api/deposits/opustack.
 *
 * POST is the signed webhook (charge.success and charge.failed). The body is
 * not trusted for the outcome or the amount: after the signature check we ask
 * OpusTack to verify the reference, then credit once.
 * GET is the player coming back from the checkout with ?reference= added.
 */

/** The customer coming back. Settle what can be settled, then show the account. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const reference = url.searchParams.get("reference");
  if (reference) await settle(reference);
  const account = new URL("/account", url.origin);
  if (reference) account.searchParams.set("ref", reference);
  return NextResponse.redirect(account);
}

/** The signed webhook. */
export async function POST(req: Request) {
  const raw = await req.text();

  if (!signed(raw, req.headers.get("x-opustack-signature"))) {
    console.warn("[opustack] rejected a webhook with a bad signature");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let event: { event?: unknown; data?: { reference?: unknown } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const name = typeof event.event === "string" ? event.event.trim().toLowerCase() : "";
  if (name !== "charge.success" && name !== "charge.failed") {
    // test.ping, refund.processed and anything new: received, nothing to do.
    return NextResponse.json({ ok: true, ignored: true });
  }

  const reference = typeof event.data?.reference === "string" ? event.data.reference.trim() : "";
  if (!reference) {
    console.warn("[opustack] webhook had no reference", name);
    return NextResponse.json({ ok: true, ignored: true });
  }

  const done = await settle(reference);
  if (!done) return NextResponse.json({ ok: false }, { status: 503 });
  return NextResponse.json({ ok: true });
}

/** x-opustack-signature is the hex HMAC-SHA512 of the raw body, keyed with the secret key. */
function signed(raw: string, header: string | null): boolean {
  const key = process.env.OPUSTACK_SECRET_KEY;
  if (!key || !header) return false;
  const expected = createHmac("sha512", key).update(raw).digest("hex");
  const given = Buffer.from(header.trim().toLowerCase());
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Ask OpusTack how the charge ended up and act on the answer. Crediting is
 * idempotent, so the browser, the webhook and the poll can all arrive at once.
 * False means the answer is not final yet, so the webhook should be retried.
 */
async function settle(reference: string): Promise<boolean> {
  const supabase = db();
  if (!supabase) return false;

  const { data: payment } = await supabase
    .from("payments")
    .select("reference, user_id, amount, currency, provider, status, metadata")
    .eq("reference", reference)
    .maybeSingle();

  if (!payment || payment.provider !== "opustack") return true;
  // A failed row is asked about again: a first attempt can fail and the player
  // can still pay afterwards, and that success must credit.
  const wasFailed = payment.status === "failed";
  if (payment.status !== "pending" && !wasFailed) return true;

  try {
    const outcome = await adapterFor("opustack").status(
      reference,
      (payment.metadata ?? undefined) as Record<string, unknown> | undefined,
    );

    if (outcome.status === "confirmed") {
      await applyDepositCredit({
        userId: payment.user_id,
        amount: settledAmount(outcome, Number(payment.amount), payment.currency),
        currency: payment.currency,
        reference,
        provider: payment.provider,
      });
      return true;
    }
    if (outcome.status === "failed") {
      await supabase
        .from("payments")
        .update({ status: "failed", resolved_at: new Date().toISOString() })
        .eq("reference", reference)
        .eq("status", "pending");
      return true;
    }
    // Nothing new to record for a row already written off, so no retry.
    return wasFailed;
  } catch (err) {
    console.error("[opustack] could not settle from the callback", reference, err);
    return false;
  }
}
