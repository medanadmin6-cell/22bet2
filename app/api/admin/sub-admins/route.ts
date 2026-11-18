import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/admin-guard";
import { startOfToday, totalPerCurrency } from "@/lib/money";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/** Approve partners, read their payout details, settle commission. */
export async function GET(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const supabase = db();
  if (!supabase) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });

  const params = new URL(req.url).searchParams;

  // The term goes into a PostgREST filter string, so anything that has meaning
  // there (quotes, separators, wildcards) is dropped rather than escaped.
  const term = (params.get("q") ?? "").replace(/["\\,()%*]/g, " ").trim().slice(0, 80);
  const match = term
    ? ["name", "email", "phone", "referral_code"].map((col) => `${col}.ilike."%${term}%"`).join(",")
    : null;

  let counting = supabase.from("sub_admins").select("id", { count: "exact", head: true });
  if (match) counting = counting.or(match);
  const { count, error: countError } = await counting;
  if (countError) return NextResponse.json({ error: "Could not load partners" }, { status: 500 });

  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamped, because PostgREST answers a range past the end with an error.
  const requested = Math.floor(Number(params.get("page")));
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pages) : 1;
  const from = (page - 1) * PAGE_SIZE;

  let listing = supabase
    .from("sub_admins")
    .select("id, name, email, phone, referral_code, approved, balances, lifetime, payout_name, payout_network, payout_number, created_at");
  if (match) listing = listing.or(match);
  const { data: partners, error } = await listing
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: "Could not load partners" }, { status: 500 });

  const ids = (partners ?? []).map((p) => p.id);

  // Referred-player counts, so the operator can see who is actually working.
  // Counted per partner: reading the referred users back stops at PostgREST's
  // 1000 rows per response, which undercounts once there are more than that.
  const playerCounts = await Promise.all(
    ids.map(async (id) => {
      const { count: players } = await supabase
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("referred_by", id);
      return [id, players ?? 0] as const;
    }),
  );
  const byPartner = new Map(playerCounts);

  // What each partner on this page has earned today, so the operator can see
  // who is working now rather than only who has earned at some point.
  const todayByPartner = new Map<string, { amount: number; currency: string }[]>();
  const chunk = 1000;
  for (let offset = 0; ids.length; offset += chunk) {
    const { data: todayRows } = await supabase
      .from("commissions")
      .select("id, sub_admin_id, amount, currency")
      .in("sub_admin_id", ids)
      .gte("created_at", startOfToday())
      .order("id")
      .range(offset, offset + chunk - 1);
    for (const row of todayRows ?? []) {
      const list = todayByPartner.get(row.sub_admin_id) ?? [];
      list.push({ amount: Number(row.amount), currency: row.currency });
      todayByPartner.set(row.sub_admin_id, list);
    }
    if (!todayRows || todayRows.length < chunk) break;
  }

  return NextResponse.json({
    partners: (partners ?? []).map((p) => ({
      ...p,
      referredPlayers: byPartner.get(p.id) ?? 0,
      today: totalPerCurrency(todayByPartner.get(p.id)),
    })),
    page,
    pages,
    pageSize: PAGE_SIZE,
    total,
  });
}

export async function PATCH(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const supabase = db();
  if (!supabase) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });

  const body = await req.json().catch(() => null);
  if (!body?.id || !body?.action) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  if (body.action === "approve" || body.action === "revoke") {
    await supabase.from("sub_admins").update({ approved: body.action === "approve" }).eq("id", body.id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "settle") {
    // Settling zeroes the currency's balance but leaves the lifetime total, so
    // the partner keeps a record of everything they have ever earned.
    const currency = String(body.currency ?? "");
    const { data: partner } = await supabase
      .from("sub_admins")
      .select("balances")
      .eq("id", body.id)
      .maybeSingle();

    if (!partner) return NextResponse.json({ error: "Partner not found" }, { status: 404 });

    const balances = { ...((partner.balances ?? {}) as Record<string, number>) };
    const settled = balances[currency] ?? 0;
    balances[currency] = 0;

    await supabase.from("sub_admins").update({ balances }).eq("id", body.id);
    console.info("[admin] commission settled", { partner: body.id, currency, settled });
    return NextResponse.json({ ok: true, settled });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
