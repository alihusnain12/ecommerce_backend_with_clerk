import mongoose from 'mongoose';

// ─────────────────────────────────────────────
// INTERFACE
// ─────────────────────────────────────────────

/**
 * IOrderItem represents ONE product line inside an order,
 * tied to a specific vendor.
 *
 * ──────────────────────────────────────────────────
 * WHY DOES THIS COLLECTION EXIST?
 * ──────────────────────────────────────────────────
 * In a multivendor app, a single buyer checkout can include products
 * from Vendor A, Vendor B, and Vendor C.  We need to:
 *
 *   1. Let each vendor see and manage ONLY their own items
 *      (e.g. Vendor A marks their items "shipped" without seeing Vendor B's)
 *
 *   2. Send a separate Stripe Transfer to each vendor's bank account
 *      and record which transfer covers which items
 *
 *   3. Snapshot the price at purchase time so vendor price changes
 *      don't rewrite history
 *
 *   4. Track per-item status independently
 *      (Vendor A's items can be "delivered" while Vendor B's are still "shipped")
 *
 * Embedding all this inside the Order document would make it impossible
 * to index or query by vendor efficiently, and would mix concerns badly.
 *
 * ──────────────────────────────────────────────────
 * RELATIONSHIP SUMMARY
 * ──────────────────────────────────────────────────
 *   Order      1 ──────── N  OrderItem   (one order has many items)
 *   User(vendor) 1 ─────── N  OrderItem   (one vendor has many order items)
 *   Product    1 ──────── N  OrderItem   (one product appears in many orders)
 */
export interface IOrderItem extends mongoose.Document {
  // ── Parent references ────────────────────────────────────────
  order: mongoose.Types.ObjectId;   // which Order this line belongs to
  vendor: mongoose.Types.ObjectId;  // which vendor sells this product
                                    // (denormalised from Product.vendor at checkout)

  // ── Product snapshot ────────────────────────────────────────
  product: mongoose.Types.ObjectId; // reference to the Product document

  quantity: number;

  // Price PER UNIT at the time of purchase.
  // We copy product.price into this field during checkout.
  // This way, if the vendor later changes the product price,
  // old order history remains accurate.
  priceAtPurchase: number;

  // The specific variant the buyer chose (optional — only if product has variants)
  selectedColor?: string;
  selectedSize?: string;

  // ── Per-item fulfilment status ───────────────────────────────
  // Each vendor updates THIS status for their own items only.
  // The parent Order.orderStatus is derived from these.
  itemStatus: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

  // ── Financial fields ─────────────────────────────────────────
  // Total amount due to the vendor for this line:
  //   vendorPayout = priceAtPurchase * quantity * (1 - platformFeeRate)
  // Stored at order creation so it's fixed regardless of fee rate changes.
  vendorPayout: number;

  // Stripe Transfer ID populated AFTER the webhook confirms payment success
  // and we call stripe.transfers.create({ destination: vendor.stripeAccountId }).
  // Format: "tr_3ABC..."
  // Null until the transfer is actually made.
  stripeTransferId?: string;

  // If the item is refunded, we store the Stripe Refund ID here
  // so support can trace it back to the original charge.
  stripeRefundId?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

// ─────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────

const orderItemSchema = new mongoose.Schema<IOrderItem>(
  {
    // ── Parent Order reference ───────────────────────────────────
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: [true, 'Order reference is required'],
      index: true,
      // When the buyer wants to see their full receipt, we query:
      //   OrderItem.find({ order: orderId }).populate('product vendor')
    },

    // ── Vendor reference ─────────────────────────────────────────
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Vendor reference is required'],
      index: true,
      // This is the field that makes the vendor dashboard work:
      //   OrderItem.find({ vendor: req.user._id, itemStatus: 'pending' })
      // Without this field on the document (and without the index),
      // we'd have to scan ALL orders and their items to find vendor-specific ones.
    },

    // ── Product reference ────────────────────────────────────────
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product reference is required'],
      // Used to populate product name, images, etc. when displaying orders.
      // Do NOT rely on product.price for billing — use priceAtPurchase.
    },

    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
    },

    priceAtPurchase: {
      type: Number,
      required: [true, 'Price at purchase is required'],
      min: [0, 'Price cannot be negative'],
      // HOW TO SET THIS:
      //   const product = await Product.findById(item.productId);
      //   priceAtPurchase = product.price;   // snapshot at checkout moment
    },

    selectedColor: {
      type: String,
      trim: true,
      // Only meaningful if the product has a colors array.
      // Validate at the controller level that selectedColor ∈ product.colors.
    },

    selectedSize: {
      type: String,
      trim: true,
      // Same note as selectedColor.
    },

    itemStatus: {
      type: String,
      enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'],
      default: 'pending',
      // STATUS LIFECYCLE:
      //
      //   pending    → set when OrderItem is created (checkout)
      //   confirmed  → set by webhook after Stripe payment succeeds
      //                (your webhook calls OrderItem.updateMany({ order }, { itemStatus: 'confirmed' }))
      //   shipped    → set by VENDOR when they dispatch the item
      //   delivered  → set by VENDOR (or by a delivery webhook) on receipt
      //   cancelled  → set if order is cancelled before shipping
      //   refunded   → set after stripe.refunds.create() succeeds for this item
      //
      // IMPORTANT: Only the owning vendor (or an admin) should be allowed
      // to update this field.  Add a middleware guard:
      //   if (req.user.role !== 'admin' && orderItem.vendor.toString() !== req.user._id.toString())
      //     throw new ForbiddenError()
    },

    vendorPayout: {
      type: Number,
      required: [true, 'Vendor payout amount is required'],
      min: [0, 'Payout cannot be negative'],
      // FORMULA (calculate in your checkout service, not here):
      //   const PLATFORM_FEE_RATE = 0.10;   // 10% platform commission
      //   vendorPayout = priceAtPurchase * quantity * (1 - PLATFORM_FEE_RATE);
      //
      // WHY STORE IT?
      //   - If you change your fee rate next year, historical payouts stay correct.
      //   - Used as the `amount` when calling stripe.transfers.create().
    },

    stripeTransferId: {
      type: String,
      // Set AFTER payment succeeds, inside your Stripe webhook handler:
      //
      //   const transfer = await stripe.transfers.create({
      //     amount: Math.round(orderItem.vendorPayout * 100),  // Stripe uses cents
      //     currency: 'usd',
      //     destination: vendor.stripeAccountId,              // "acct_1ABC..."
      //     transfer_group: order._id.toString(),             // links transfers to this order
      //   });
      //   await OrderItem.findByIdAndUpdate(orderItem._id, { stripeTransferId: transfer.id });
      //
      // The transfer_group lets you see all vendor payouts for one order
      // grouped together in the Stripe dashboard.
    },

    stripeRefundId: {
      type: String,
      // Set if this specific item is refunded:
      //
      //   const refund = await stripe.refunds.create({
      //     charge: order.stripeChargeId,
      //     amount: Math.round(orderItem.priceAtPurchase * orderItem.quantity * 100),
      //   });
      //   await OrderItem.findByIdAndUpdate(orderItem._id, {
      //     stripeRefundId: refund.id,
      //     itemStatus: 'refunded',
      //   });
      //
      // You'll also need to reverse the vendor transfer (stripe.transfers.createReversal)
      // or handle it out-of-band depending on your policy.
    },
  },
  {
    timestamps: true,
  }
);

// ─────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────

// MOST IMPORTANT INDEX: vendor dashboard —
// "show me all pending items I need to fulfil, newest first"
orderItemSchema.index({ vendor: 1, itemStatus: 1, createdAt: -1 });

// Fetching all line items for a specific order (buyer's receipt, admin view)
// Note: Index already created by index: true on order field

// Compound: useful when a vendor filters their items within a specific order
orderItemSchema.index({ order: 1, vendor: 1 });

// Admin / finance: find items where a transfer hasn't been sent yet
// (i.e. payment succeeded but transfer is still null — useful for recovery jobs)
orderItemSchema.index({ stripeTransferId: 1, itemStatus: 1 });

// ─────────────────────────────────────────────
// VIRTUAL: subtotal
// ─────────────────────────────────────────────

/**
 * subtotal is a computed value, not stored in DB.
 * Access it like: orderItem.subtotal
 * It's excluded from toJSON/toObject by default unless you pass { virtuals: true }.
 */
orderItemSchema.virtual('subtotal').get(function (this: IOrderItem) {
  return this.priceAtPurchase * this.quantity;
});

// ─────────────────────────────────────────────
// MODEL EXPORT
// ─────────────────────────────────────────────

const OrderItem = mongoose.model<IOrderItem>('OrderItem', orderItemSchema);

export default OrderItem;