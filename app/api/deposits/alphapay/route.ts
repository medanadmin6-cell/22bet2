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

  if (
    !signed(
      raw,
      req.headers.get("x-webhook-signature") ?? req.headers.get("x-alphapay-signature"),
      req.headers.get("x-webhook-timestamp"),
    )
  ) {
    console.warn("[alphapay] rejected a webhook with a bad signature");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let event: { data?: { reference?: unknown; metadata?: { reference?: unknown } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const nested = event.data?.metadata?.reference;
  const reference =
    (typeof nested === "string" && nested) ||
    (typeof event.data?.reference === "string" ? event.data.reference : "");
  if (!reference) return NextResponse.json({ ok: true, ignored: true });

  await settle(reference);
  return NextResponse.json({ ok: true });
}

/**
 * AlphaPay signs `${timestamp}.${raw body}` with the webhook secret.
 * X-Webhook-Signature is the lowercase hex digest. A stamp older than five
 * minutes is rejected, the same window Betzone uses.
 */
function signed(raw: string, header: string | null, timestamp: string | null): boolean {
  const key = process.env.ALPHAPAY_WEBHOOK_SECRET || process.env.ALPHAPAY_SECRET_KEY;
  if (!key || !header) return false;
  if (timestamp) {
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return false;
  }
  const signedBody = timestamp ? `${timestamp}.${raw}` : raw;
  const expected = createHmac("sha256", key).update(signedBody).digest("hex");
  const given = Buffer.from(header.trim().toLowerCase().replace(/^sha256=/, ""));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
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
    const outcome = await adapterFor("alphapay").status(
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
