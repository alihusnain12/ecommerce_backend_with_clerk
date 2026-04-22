import type { Request, Response } from 'express';
import Stripe from 'stripe';
import Order from '../models/order.model.ts';
import OrderItem from '../models/orderItem.model.ts';
import Product from '../models/product.model.ts';
import User from '../models/user.model.ts';

// ─────────────────────────────────────────────
// STRIPE INITIALISATION
// ─────────────────────────────────────────────

/**
 * Initialise the Stripe SDK with your secret key.
 * STRIPE_SECRET_KEY is set in .env — never expose this to the frontend.
 * apiVersion pins the Stripe API version so upgrades don't silently
 * break your integration.
 * 
 * Lazy initialization to ensure environment variables are loaded
 */
let stripe: any | null = null;

const getStripe = (): any => {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY environment variable is not set');
    }
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-03-25.dahlia',
    });
  }
  return stripe;
};

// Platform fee rate: 10% of each transaction goes to you,
// 90% is transferred to the vendor.
// Store this as a constant so it's one place to change.
const PLATFORM_FEE_RATE = 0.10;

// ─────────────────────────────────────────────
// CHECKOUT — CREATE ORDER + STRIPE PAYMENT INTENT
// POST /api/orders/checkout
// Access: authenticated buyers
// ─────────────────────────────────────────────

/**
 * checkout: the single most important function in the whole app.
 *
 * What it does step by step:
 *  1. Validate every cart item (product exists, is active, has enough stock)
 *  2. Calculate totals (subtotal per item, platform fee, grand total)
 *  3. Create the parent Order document in MongoDB
 *  4. Create one OrderItem per cart line, each linked to its vendor
 *  5. Create a Stripe PaymentIntent for the full grand total
 *  6. Update the Order with the PaymentIntent ID
 *  7. Return the client_secret to the frontend so Stripe.js can show the payment form
 *
 * NOTE: stock is NOT decremented here. It's decremented inside the
 * Stripe webhook (handleStripeWebhook) AFTER payment actually succeeds.
 * This prevents stock being locked by abandoned carts.
 *
 * Request body:
 * {
 *   cartItems: [
 *     { productId: "...", quantity: 2, selectedColor: "red", selectedSize: "M" },
 *     { productId: "...", quantity: 1 }
 *   ],
 *   shippingAddress: { street, city, state, postalCode, country }
 * }
 */
export const checkout = async (req: Request, res: Response): Promise<void> => {
  try {
    const { cartItems, shippingAddress } = req.body;

    if (!cartItems || cartItems.length === 0) {
      res.status(400).json({ success: false, message: 'Cart is empty.' });
      return;
    }

    // ── Step 1: Validate products and fetch their current data ──
    // We fetch all products in a single query using $in to avoid N separate DB calls
    const productIds = cartItems.map((item: any) => item.productId);
    const products = await Product.findById
      ? await Product.find({ _id: { $in: productIds }, isActive: true }).populate('vendor', '_id stripeAccountId stripeOnboardingComplete')
      : [];

    // Build a lookup map: productId → product document
    // This lets us access products in O(1) when building order items
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    // Validate each cart item
    for (const item of cartItems) {
      const product = productMap.get(item.productId);

      if (!product) {
        res.status(400).json({
          success: false,
          message: `Product ${item.productId} not found or is no longer available.`,
        });
        return;
      }

      if (product.stock < item.quantity) {
        res.status(400).json({
          success: false,
          message: `Insufficient stock for "${product.name}". Available: ${product.stock}.`,
        });
        return;
      }

      // Validate selected variant options against the product's available options
      if (item.selectedColor && product.colors && !product.colors.includes(item.selectedColor)) {
        res.status(400).json({
          success: false,
          message: `Color "${item.selectedColor}" is not available for "${product.name}".`,
        });
        return;
      }

      if (item.selectedSize && product.sizes && !product.sizes.includes(item.selectedSize)) {
        res.status(400).json({
          success: false,
          message: `Size "${item.selectedSize}" is not available for "${product.name}".`,
        });
        return;
      }
    }

    // ── Step 2: Calculate totals ────────────────────────────────
    let totalPrice = 0;
    const orderItemsData: any[] = [];

    for (const item of cartItems) {
      const product = productMap.get(item.productId)!;
      const priceAtPurchase = product.price; // snapshot NOW — not a reference
      const lineTotal = priceAtPurchase * item.quantity;
      const vendorPayout = lineTotal * (1 - PLATFORM_FEE_RATE);

      totalPrice += lineTotal;

      orderItemsData.push({
        // order: set after Order is created (step 3)
        vendor: product.vendor, // denormalised from the product
        product: product._id,
        quantity: item.quantity,
        priceAtPurchase,
        selectedColor: item.selectedColor,
        selectedSize: item.selectedSize,
        vendorPayout,
        itemStatus: 'pending',
      });
    }

    const platformFee = totalPrice * PLATFORM_FEE_RATE;

    // ── Step 3: Create the parent Order (no PaymentIntent yet) ──
    // We create the Order first so we have an _id to link OrderItems to.
    // stripePaymentIntentId is required in schema — use a placeholder,
    // then update it after Stripe responds (step 5-6).
    const order = await Order.create({
      user: req.user!._id,
      totalPrice,
      platformFee,
      shippingAddress,
      paymentStatus: 'pending',
      orderStatus: 'processing',
      stripePaymentIntentId: 'pending_' + Date.now(), // temporary — replaced in step 6
    });

    // ── Step 4: Create all OrderItems, linking to the new Order ─
    const orderItemDocs = orderItemsData.map((item) => ({
      ...item,
      order: order._id,
    }));
    await OrderItem.insertMany(orderItemDocs);

    // ── Step 5: Create Stripe PaymentIntent ─────────────────────
    // amount is in the SMALLEST currency unit (cents for USD, fils for AED, etc.)
    const paymentIntent = await getStripe().paymentIntents.create({
      amount: Math.round(totalPrice * 100), // e.g. $49.99 → 4999 cents
      currency: 'usd', // change to your currency
      metadata: {
        orderId: order._id.toString(), // stored so our webhook can find the Order
        userId: req.user!._id,
      },
      // transfer_group links all vendor transfers to this single payment in Stripe dashboard
      transfer_group: order._id.toString(),
    });

    // ── Step 6: Update Order with the real PaymentIntent ID ─────
    order.stripePaymentIntentId = paymentIntent.id;
    await order.save();

    // ── Step 7: Return client_secret to the frontend ─────────────
    // The frontend uses this with Stripe.js / stripe.confirmPayment()
    // to show the payment form and process the card.
    res.status(201).json({
      success: true,
      message: 'Order created. Complete payment using the client secret.',
      data: {
        orderId: order._id,
        totalPrice,
        platformFee,
        clientSecret: paymentIntent.client_secret, // ONLY this goes to frontend
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// STRIPE WEBHOOK
// POST /api/orders/webhook
// Access: Stripe only (verified by signature)
// ─────────────────────────────────────────────

/**
 * handleStripeWebhook: receives events POSTed by Stripe after payment activity.
 *
 * CRITICAL SETUP REQUIREMENTS:
 *  1. This route must use express.raw() middleware (NOT express.json())
 *     because we need the raw request body to verify Stripe's signature.
 *     Set this up in your app.ts BEFORE the json middleware:
 *       app.post('/api/orders/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook)
 *
 *  2. Set STRIPE_WEBHOOK_SECRET in .env — get it from:
 *       stripe listen --forward-to localhost:3000/api/orders/webhook
 *     (for local dev) or from the Stripe dashboard for production.
 *
 * Events handled:
 *  - payment_intent.succeeded  → mark order paid, trigger vendor transfers, decrement stock
 *  - payment_intent.payment_failed → mark order failed
 */
export const handleStripeWebhook = async (req: Request, res: Response): Promise<void> => {
  const sig = req.headers['stripe-signature'] as string;

  let event;

  try {
    // Verify the webhook signature — this confirms the event really came from Stripe
    // and wasn't forged by a malicious actor hitting your webhook endpoint.
    event = getStripe().webhooks.constructEvent(
      req.body, // must be raw Buffer — use express.raw() on this route
      sig,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
  } catch (err: any) {
    // If signature verification fails, reject immediately
    console.error('Stripe webhook signature verification failed:', err.message);
    res.status(400).json({ message: `Webhook error: ${err.message}` });
    return;
  }

  // ── Handle each event type ──────────────────────────────────

  if (event.type === 'payment_intent.succeeded') {
    await handlePaymentSuccess(event.data.object as any);
  }

  if (event.type === 'payment_intent.payment_failed') {
    await handlePaymentFailed(event.data.object as any);
  }

  // Always return 200 quickly — Stripe retries if you don't respond within 30s
  res.status(200).json({ received: true });
};

// ─────────────────────────────────────────────
// PRIVATE: handle successful payment
// ─────────────────────────────────────────────

/**
 * handlePaymentSuccess: runs inside the webhook after payment_intent.succeeded.
 *
 * What it does:
 *  1. Finds the Order by PaymentIntent ID
 *  2. Marks the Order as paid
 *  3. Confirms all OrderItems
 *  4. Decrements stock for each product
 *  5. Groups OrderItems by vendor and sends a Stripe Transfer to each vendor
 */
const handlePaymentSuccess = async (paymentIntent: any): Promise<void> => {
  // Find the order using the PaymentIntent ID stored at checkout
  const order = await Order.findOne({ stripePaymentIntentId: paymentIntent.id });
  if (!order) {
    console.error('Webhook: Order not found for PaymentIntent', paymentIntent.id);
    return;
  }

  // Idempotency guard: if we already processed this event, skip
  // (Stripe can deliver the same event more than once)
  if (order.paymentStatus === 'paid') {
    console.log('Webhook: Order already processed, skipping.', order._id);
    return;
  }

  // Extract the charge ID — needed later for refunds
  // The latest_charge is the actual charge object attached to the PaymentIntent
  const chargeId =
    typeof paymentIntent.latest_charge === 'string'
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id;

  // Mark the order as paid
  order.paymentStatus = 'paid';
  order.orderStatus = 'confirmed';
  if (chargeId) order.stripeChargeId = chargeId;
  await order.save();

  // Fetch all OrderItems for this order, with vendor details needed for transfer
  const orderItems = await OrderItem.find({ order: order._id }).populate(
    'vendor',
    '_id stripeAccountId stripeOnboardingComplete'
  );

  // Confirm all items and decrement stock in parallel
  // We use Promise.all for efficiency — these are independent operations
  await Promise.all(
    orderItems.map(async (item) => {
      // Mark item as confirmed
      item.itemStatus = 'confirmed';
      await item.save();

      // Decrement the product stock
      // $inc is atomic — safer than read-modify-write in a concurrent environment
      await Product.findByIdAndUpdate(item.product, {
        $inc: { stock: -item.quantity },
      });
    })
  );

  // ── Group items by vendor and send transfers ─────────────────
  // We need to send ONE transfer per vendor (not one per item),
  // summing up all their items' vendorPayout values.

  // Build a map: vendorId → { vendor doc, total payout }
  const vendorPayoutMap = new Map<
    string,
    { vendor: any; totalPayout: number; itemIds: string[] }
  >();

  for (const item of orderItems) {
    const vendor = item.vendor as any;
    const vendorId = String(vendor._id);
    const existing = vendorPayoutMap.get(vendorId);

    if (existing) {
      existing.totalPayout += item.vendorPayout;
      existing.itemIds.push(String(item._id));
    } else {
      vendorPayoutMap.set(vendorId, {
        vendor,
        totalPayout: item.vendorPayout,
        itemIds: [String(item._id)],
      });
    }
  }

  // Send a Stripe Transfer to each vendor
  for (const [vendorId, { vendor, totalPayout, itemIds }] of vendorPayoutMap) {
    // Skip vendors who haven't completed Stripe onboarding — they have no account to receive funds
    if (!vendor.stripeOnboardingComplete || !vendor.stripeAccountId) {
      console.warn(`Vendor ${vendorId} has not completed Stripe onboarding — skipping transfer.`);
      continue;
    }

    try {
      const transfer = await getStripe().transfers.create({
        amount: Math.round(totalPayout * 100), // cents
        currency: 'usd',
        destination: vendor.stripeAccountId, // "acct_1ABC..."
        transfer_group: order._id.toString(), // visible grouping in Stripe dashboard
        metadata: {
          orderId: order._id.toString(),
          vendorId,
        },
      });

      // Save the transfer ID on all of this vendor's items for the order
      await OrderItem.updateMany(
        { _id: { $in: itemIds } },
        { stripeTransferId: transfer.id }
      );
    } catch (transferError: any) {
      // Log but don't throw — a failed transfer shouldn't undo the payment confirmation.
      // You'll want a background job or admin alert to retry failed transfers.
      console.error(`Transfer failed for vendor ${vendorId}:`, transferError.message);
    }
  }
};

// ─────────────────────────────────────────────
// PRIVATE: handle failed payment
// ─────────────────────────────────────────────

const handlePaymentFailed = async (paymentIntent: any): Promise<void> => {
  const order = await Order.findOne({ stripePaymentIntentId: paymentIntent.id });
  if (!order) return;

  order.paymentStatus = 'failed';
  order.orderStatus = 'cancelled';
  await order.save();

  // Cancel all order items so vendors aren't confused by ghost orders
  await OrderItem.updateMany({ order: order._id }, { itemStatus: 'cancelled' });
};

// ─────────────────────────────────────────────
// GET BUYER'S OWN ORDERS
// GET /api/orders/my-orders
// Access: authenticated buyer
// ─────────────────────────────────────────────

/**
 * getMyOrders: returns all orders placed by the authenticated buyer.
 * We populate the OrderItems separately via virtual populate or a
 * second query to avoid embedding them inside the Order document.
 */
export const getMyOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const [orders, total] = await Promise.all([
      Order.find({ user: req.user!._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments({ user: req.user!._id }),
    ]);

    // Fetch all items for these orders in a single query
    // (more efficient than N queries inside a loop)
    const orderIds = orders.map((o) => o._id);
    const orderItems = await OrderItem.find({ order: { $in: orderIds } })
      .populate('product', 'name images price')
      .populate('vendor', 'name')
      .lean();

    // Group items by order ID for easy attachment
    const itemsByOrder = new Map<string, any[]>();
    for (const item of orderItems) {
      const key = String(item.order);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key)!.push(item);
    }

    // Attach items to their parent order
    const ordersWithItems = orders.map((order) => ({
      ...order,
      items: itemsByOrder.get(String(order._id)) ?? [],
    }));

    res.status(200).json({
      success: true,
      data: ordersWithItems,
      pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// GET SINGLE ORDER (buyer's own)
// GET /api/orders/:id
// Access: authenticated buyer (must own the order) or admin
// ─────────────────────────────────────────────

export const getOrderById = async (req: Request, res: Response): Promise<void> => {
  try {
    const order = await Order.findById(req.params.id).lean();

    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found.' });
      return;
    }

    // Ownership check: buyer can only see their own orders
    if (String(order.user) !== req.user!._id && req.user!.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Access denied.' });
      return;
    }

    const items = await OrderItem.find({ order: order._id })
      .populate('product', 'name images description')
      .populate('vendor', 'name email')
      .lean();

    res.status(200).json({ success: true, data: { ...order, items } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// GET VENDOR'S ORDER ITEMS
// GET /api/orders/vendor/items
// Access: vendor only
// ─────────────────────────────────────────────

/**
 * getVendorOrderItems: returns all OrderItems belonging to the authenticated vendor.
 *
 * This is the vendor's fulfilment dashboard — they see ONLY their items,
 * never items from other vendors within the same order.
 */
export const getVendorOrderItems = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, any> = { vendor: req.user!._id };

    // Filter by item status (vendor may want to see only "confirmed" items to ship)
    if (status) filter.itemStatus = status;

    const [items, total] = await Promise.all([
      OrderItem.find(filter)
        .populate('product', 'name images price')
        .populate('order', 'shippingAddress createdAt totalPrice')
        .populate('vendor', 'name') // the vendor themselves — useful for display
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      OrderItem.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: items,
      pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// UPDATE ITEM STATUS (vendor ships / delivers)
// PATCH /api/orders/items/:itemId/status
// Access: vendor only (must own the item)
// ─────────────────────────────────────────────

/**
 * updateItemStatus: lets a vendor mark their item as shipped or delivered.
 *
 * After updating, we check if ALL items in the parent order are now
 * delivered/shipped, and update the parent Order.orderStatus accordingly
 * so the buyer sees accurate progress.
 */
export const updateItemStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = req.body;

    // Only these transitions are allowed from the vendor side
    const allowedStatuses = ['confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!allowedStatuses.includes(status)) {
      res.status(400).json({
        success: false,
        message: `Invalid status. Allowed: ${allowedStatuses.join(', ')}`,
      });
      return;
    }

    const item = await OrderItem.findById(req.params.itemId);

    if (!item) {
      res.status(404).json({ success: false, message: 'Order item not found.' });
      return;
    }

    // Vendors can only update their own items
    if (String(item.vendor) !== req.user!._id && req.user!.role !== 'admin') {
      res.status(403).json({ success: false, message: 'You do not own this order item.' });
      return;
    }

    item.itemStatus = status;
    await item.save();

    // ── Derive and update the parent Order's status ─────────────
    // Fetch all sibling items for this order to compute the aggregate status
    const allItems = await OrderItem.find({ order: item.order }).lean();

    const statuses = allItems.map((i) => i.itemStatus);
    let newOrderStatus: string;

    if (statuses.every((s) => s === 'delivered')) {
      newOrderStatus = 'delivered';
    } else if (statuses.every((s) => s === 'cancelled')) {
      newOrderStatus = 'cancelled';
    } else if (statuses.some((s) => s === 'shipped' || s === 'delivered')) {
      newOrderStatus = statuses.every((s) => s === 'shipped' || s === 'delivered')
        ? 'shipped'
        : 'partially_shipped';
    } else {
      newOrderStatus = 'confirmed';
    }

    await Order.findByIdAndUpdate(item.order, { orderStatus: newOrderStatus });

    res.status(200).json({
      success: true,
      message: `Item status updated to "${status}".`,
      data: item,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// ADMIN: GET ALL ORDERS
// GET /api/orders/admin/all
// Access: admin only
// ─────────────────────────────────────────────

export const adminGetAllOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const { paymentStatus, orderStatus, page = 1, limit = 20 } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, any> = {};
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (orderStatus) filter.orderStatus = orderStatus;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: orders,
      pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// REFUND SINGLE ITEM
// POST /api/orders/items/:itemId/refund
// Access: admin only
// ─────────────────────────────────────────────

/**
 * refundOrderItem: issues a partial Stripe refund for a single item
 * and reverses the vendor transfer.
 *
 * When would you use this?
 *  - A buyer reports an item was damaged or never arrived
 *  - Admin decides to refund just that item, not the whole order
 */
export const refundOrderItem = async (req: Request, res: Response): Promise<void> => {
  try {
    const item = await OrderItem.findById(req.params.itemId);
    if (!item) {
      res.status(404).json({ success: false, message: 'Order item not found.' });
      return;
    }

    if (item.itemStatus === 'refunded') {
      res.status(400).json({ success: false, message: 'Item has already been refunded.' });
      return;
    }

    const order = await Order.findById(item.order);
    if (!order || !order.stripeChargeId) {
      res.status(400).json({ success: false, message: 'Cannot find charge to refund against.' });
      return;
    }

    // Calculate refund amount for this item (full item value, not just vendor payout)
    const refundAmount = Math.round(item.priceAtPurchase * item.quantity * 100);

    // Issue partial refund on the original charge
    const refund = await getStripe().refunds.create({
      charge: order.stripeChargeId,
      amount: refundAmount,
      metadata: { orderItemId: String(item._id), orderId: String(order._id) },
    });

    // Reverse the vendor transfer if it was already sent
    if (item.stripeTransferId) {
      await getStripe().transfers.createReversal(item.stripeTransferId, {
        amount: Math.round(item.vendorPayout * 100),
        metadata: { reason: 'item_refunded', orderItemId: String(item._id) },
      });
    }

    // Update item and order records
    item.itemStatus = 'refunded';
    item.stripeRefundId = refund.id;
    await item.save();

    // Check if all items are now refunded → mark whole order as refunded
    const allItems = await OrderItem.find({ order: order._id }).lean();
    if (allItems.every((i) => i.itemStatus === 'refunded')) {
      order.paymentStatus = 'refunded';
    } else {
      order.paymentStatus = 'partially_refunded';
    }
    await order.save();

    res.status(200).json({
      success: true,
      message: 'Item refunded successfully.',
      data: { refundId: refund.id },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};