import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({
  orderId: z.string().uuid(),
});

export async function POST(req: Request) {
  try {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON request" },
        { status: 400 },
      );
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "A valid order ID is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!user.email) {
      return NextResponse.json(
        { error: "Your account needs a valid email address" },
        { status: 400 },
      );
    }

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id,buyer_id,total_amount,status,payment_status")
      .eq("id", parsed.data.orderId)
      .eq("buyer_id", user.id)
      .maybeSingle();

    if (orderError) {
      console.error("Payment order lookup failed:", orderError.message);
      return NextResponse.json(
        { error: "Unable to check this order right now" },
        { status: 500 },
      );
    }

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (
      order.status !== "pending" ||
      !["unpaid", "failed"].includes(order.payment_status)
    ) {
      return NextResponse.json(
        { error: "This order is not available for payment" },
        { status: 409 },
      );
    }

    const amountNaira = Number(order.total_amount);

    if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
      return NextResponse.json(
        { error: "The order has an invalid total amount" },
        { status: 400 },
      );
    }

    const amountKobo = Math.round(amountNaira * 100);

    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      return NextResponse.json(
        { error: "The order amount is invalid" },
        { status: 400 },
      );
    }

    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (!secret) {
      return NextResponse.json(
        { error: "Payment service is not configured" },
        { status: 503 },
      );
    }

    const reference = `camptrade_${randomUUID()}`;

    let response: Response;

    try {
      response = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: user.email,
            amount: amountKobo,
            currency: "NGN",
            reference,
          }),
          cache: "no-store",
        },
      );
    } catch {
      return NextResponse.json(
        { error: "Could not connect to the payment service" },
        { status: 502 },
      );
    }

    let result: any;

    try {
      result = await response.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid response from the payment service" },
        { status: 502 },
      );
    }

    if (
      !response.ok ||
      result?.status !== true ||
      typeof result?.data?.authorization_url !== "string" ||
      typeof result?.data?.reference !== "string"
    ) {
      console.error("Paystack initialization failed:", result?.message);
      return NextResponse.json(
        { error: "Payment initialization failed" },
        { status: 502 },
      );
    }

    const admin = createAdminClient();

    const { data: updatedOrder, error: updateError } = await admin
      .from("orders")
      .update({
        payment_reference: result.data.reference,
        payment_status: "pending",
      })
      .eq("id", order.id)
      .eq("buyer_id", user.id)
      .eq("status", "pending")
      .in("payment_status", ["unpaid", "failed"])
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error("Could not save payment reference:", updateError.message);
      return NextResponse.json(
        { error: "Could not prepare the order for payment" },
        { status: 500 },
      );
    }

    if (!updatedOrder) {
      return NextResponse.json(
        { error: "The order changed. Refresh and try again" },
        { status: 409 },
      );
    }

    return NextResponse.json({
      authorization_url: result.data.authorization_url,
      reference: result.data.reference,
    });
  } catch (error) {
    console.error(
      "Payment initialization error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return NextResponse.json(
      { error: "Unable to initialize payment" },
      { status: 500 },
    );
  }
}
