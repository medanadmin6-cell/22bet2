import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/supabase";
import { adapterFor, settledAmount } from "@/lib/gateways";
import { applyDepositCredit } from "@/lib/money";

export const dynamic = "force-dynamic";

/**
 * AlphaPay's callback_url.
 *
 * One address gets two different visitors: the customer's browser, sent back
 * from the hosted checkout with a GET, and AlphaPay's server, POSTing the
 * signed webhook. Neither is trusted to say a payment succeeded. Both end in
 * the same place the deposit screen's poll does -- asking AlphaPay directly
 * with the secret key, and crediting what it says settled.
 */

/** The customer coming back. Settle what can be settled, then show the account. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const reference = url.searchParams.get("reference");
  if (reference) await settle(reference);
  return NextResponse.redirect(new URL("/account", url.origin));
}

/** The signed webhook. */
export async function POST(req: Request) {
  const raw = await req.text();

  if (!signed(req.headers.get("x-alphapay-signature"), raw)) {
    console.warn("[alphapay] rejected a webhook with a bad signature");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let event: { event?: string; data?: { reference?: unknown } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const reference = typeof event.data?.reference === "string" ? event.data.reference : null;
  if (!reference) return NextResponse.json({ ok: true, ignored: true });

  await settle(reference);
  return NextResponse.json({ ok: true });
}

/**
 * HMAC-SHA256 over the raw body, keyed with our secret key. Their docs do not
 * say how the digest is written out, so both spellings a signature usually
 * takes are accepted; either one can only be produced with the key.
 */
function signed(header: string | null, raw: string): boolean {
  const key = process.env.ALPHAPAY_SECRET_KEY;
  if (!key || !header) return false;

  const got = Buffer.from(header.trim().replace(/^sha256=/i, ""));
  const mac = createHmac("sha256", key).update(raw).digest();

  return [mac.toString("hex"), mac.toString("base64")].some((expected) => {
    const want = Buffer.from(expected);
    // Hex is case-insensitive; base64 is not, and is compared as sent.
    const lowered = Buffer.from(got.toString().toLowerCase());
    return (
      (want.length === got.length && timingSafeEqual(want, got)) ||
      (want.length === lowered.length && timingSafeEqual(want, lowered))
    );
  });
}

/**
 * Ask AlphaPay how the charge ended up and act on the answer. Crediting is
 * idempotent, so the browser, the webhook and the poll can all arrive at once.
 */
async function settle(reference: string): Promise<void> {
  const supabase = db();
  if (!supabase) return;

  const { data: payment } = await supabase
    .from("payments")
    .select("reference, user_id, amount, currency, provider, status, metadata")
    .eq("reference", reference)
    .maybeSingle();

  // Only a deposit this rail opened and has not already resolved.
  if (!payment || payment.provider !== "alphapay" || payment.status !== "pending") return;

  try {
    const outcome = await adapterFor("alphapay").status(reference);

    if (outcome.status === "confirmed") {
      await applyDepositCredit({
        userId: payment.user_id,
        amount: settledAmount(outcome, Number(payment.amount), payment.currency),
        currency: payment.currency,
        reference,
        provider: payment.provider,
      });
    } else if (outcome.status === "failed") {
      await supabase
        .from("payments")
        .update({ status: "failed", resolved_at: new Date().toISOString() })
        .eq("reference", reference)
        .eq("status", "pending");
    }
  } catch (err) {
    // The sweeps will come back for it.
    console.error("[alphapay] could not settle from the callback", reference, err);
  }
}
