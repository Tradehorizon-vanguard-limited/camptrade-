import crypto from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: Request) {
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret) {
    console.error("Paystack webhook secret is not configured");
    return NextResponse.json(
      { error: "Webhook is not configured" },
      { status: 503 },
    );
  }

  let raw: string;

  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "Unable to read request" }, { status: 400 });
  }

  const signature = req.headers.get("x-paystack-signature") ?? "";

  if (!/^[a-f0-9]{128}$/i.test(signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const expected = crypto
    .createHmac("sha512", secret)
    .update(raw)
    .digest();

  const received = Buffer.from(signature, "hex");

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: any;

  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  // Acknowledge valid, signed events that this endpoint does not process.
  if (event?.event !== "charge.success") {
    return NextResponse.json({ received: true });
  }

  const payment = event.data;
  const reference = payment?.reference;

  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    payment?.status !== "success" ||
    !Number.isSafeInteger(payment?.amount) ||
    payment.amount <= 0 ||
    payment.currency !== "NGN"
  ) {
    return NextResponse.json(
      { error: "Invalid payment details" },
      { status: 400 },
    );
  }

  try {
    const admin = createAdminClient();

    const { data: order, error: lookupError } = await admin
      .from("orders")
      .select("id,total_amount,status,payment_status,payment_reference")
      .eq("payment_reference", reference)
      .maybeSingle();

    if (lookupError) {
      console.error("Webhook order lookup failed:", lookupError.message);
      return NextResponse.json(
        { error: "Could not verify the order" },
        { status: 500 },
      );
    }

    if (!order) {
      console.error("No order found for Paystack reference");
      return NextResponse.json(
        { error: "Order not found for this payment" },
        { status: 500 },
      );
    }

    const expectedAmount = Math.round(Number(order.total_amount) * 100);

    if (
      !Number.isSafeInteger(expectedAmount) ||
      expectedAmount <= 0 ||
      payment.amount !== expectedAmount
    ) {
      console.error("Paystack amount does not match order total", {
        orderId: order.id,
        expectedAmount,
        receivedAmount: payment.amount,
      });

      return NextResponse.json(
        { error: "Payment amount does not match order" },
        { status: 400 },
      );
    }

    // Repeated successful notifications must not change an already-paid order.
    if (order.payment_status === "paid" && order.status === "paid") {
      return NextResponse.json({ received: true });
    }

    // Do not revive cancelled, refunded, or otherwise ineligible orders.
    if (
      order.status !== "pending" ||
      order.payment_status !== "pending"
    ) {
      console.error("Order is not eligible for payment confirmation", {
        orderId: order.id,
        status: order.status,
        paymentStatus: order.payment_status,
      });

      return NextResponse.json(
        { error: "Order is not eligible for payment confirmation" },
        { status: 409 },
      );
    }

    const { data: updatedOrder, error: updateError } = await admin
      .from("orders")
      .update({
        payment_status: "paid",
        status: "paid",
      })
      .eq("id", order.id)
      .eq("payment_reference", reference)
      .eq("status", "pending")
      .eq("payment_status", "pending")
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error("Webhook order update failed:", updateError.message);
      return NextResponse.json(
        { error: "Could not confirm payment" },
        { status: 500 },
      );
    }

    if (!updatedOrder) {
      // A concurrent webhook may already have completed the update.
      const { data: latestOrder, error: latestError } = await admin
        .from("orders")
        .select("status,payment_status,payment_reference")
        .eq("id", order.id)
        .maybeSingle();

      if (
        !latestError &&
        latestOrder?.payment_reference === reference &&
        latestOrder.status === "paid" &&
        latestOrder.payment_status === "paid"
      ) {
        return NextResponse.json({ received: true });
      }

      console.error("Order was not updated after successful payment");
      return NextResponse.json(
        { error: "Could not confirm payment status" },
        { status: 500 },
      );
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error(
      "Paystack webhook processing failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 },
    );
  }
}
