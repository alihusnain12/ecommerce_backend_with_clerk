import mongoose from 'mongoose';

// ─────────────────────────────────────────────
// INTERFACES
// ─────────────────────────────────────────────

/**
 * IAddress is an embedded sub-document — it lives inside the Order
 * rather than a separate collection because an address is only
 * meaningful in the context of the order it belongs to.
 * (If a user later changes their profile address, it must NOT
 * change the address on a historical order.)
 */
export interface IAddress {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * IOrder is the TOP-LEVEL document created when a buyer checks out.
 *
 * ONE Order can contain products from MANY vendors.
 * The individual product lines (one per product × vendor) live in
 * the separate OrderItem collection, not inside this document.
 *
 * Think of it like this:
 *   Order     = the "receipt header"  (who bought, how much, payment status)
 *   OrderItem = the "receipt lines"   (what was bought, from which vendor)
 *
 * Why separate?
 *   - Each vendor needs to update only THEIR item statuses (shipped, delivered)
 *     without touching items from other vendors.
 *   - Stripe transfers go per-vendor; each OrderItem stores its own transfer ID.
 *   - Queries like "show vendor A all their pending orders" are fast with an
 *     index on OrderItem.vendor — impossible if items were embedded here.
 */
export interface IOrder extends mongoose.Document {
  // The buyer
  user: mongoose.Types.ObjectId;

  // Grand total charged to the buyer's card (sum of all items across all vendors)
  totalPrice: number;

  // Platform commission taken before transferring to vendors.
  // e.g. if platformFeeRate = 10%, platformFee = totalPrice * 0.10
  // Storing the AMOUNT (not the rate) gives an exact audit trail even
  // if you change your fee rate in the future.
  platformFee: number;

  // ── Payment status (Stripe-driven) ───────────────────────────
  // Updated by your Stripe webhook, not by vendor/user actions.
  paymentStatus: 'pending' | 'paid' | 'failed' | 'partially_refunded' | 'refunded';

  // ── Order fulfilment status (computed / manually managed) ────
  // This is a high-level summary for the buyer.
  // Individual vendor fulfilment lives on OrderItem.itemStatus.
  // You can compute this from OrderItems:
  //   all delivered → 'delivered'
  //   any shipped   → 'partially_shipped'
  //   etc.
  orderStatus: 'processing' | 'confirmed' | 'partially_shipped' | 'shipped' | 'delivered' | 'cancelled';

  shippingAddress: IAddress;

  // ── Stripe identifiers ───────────────────────────────────────
  // stripePaymentIntentId: created BEFORE the buyer pays.
  // Its client_secret is sent to the frontend so Stripe.js can complete payment.
  // Used by your webhook to match incoming events back to this Order.
  stripePaymentIntentId: string;

  // stripeChargeId: populated AFTER payment succeeds (from the webhook payload).
  // Needed if you ever need to issue a full refund via stripe.refunds.create().
  stripeChargeId?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

// ─────────────────────────────────────────────
// SUB-SCHEMAS
// ─────────────────────────────────────────────

/**
 * addressSchema is used as an embedded sub-document inside orderSchema.
 * { _id: false } prevents Mongoose from adding an _id to the subdoc
 * since we never query addresses directly.
 */
const addressSchema = new mongoose.Schema<IAddress>(
  {
    street: {
      type: String,
      required: [true, 'Street address is required'],
    },
    city: {
      type: String,
      required: [true, 'City is required'],
    },
    state: {
      type: String,
      required: [true, 'State is required'],
    },
    postalCode: {
      type: String,
      required: [true, 'Postal code is required'],
    },
    country: {
      type: String,
      required: [true, 'Country is required'],
    },
  },
  { _id: false } // no separate _id for the embedded address
);

// ─────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────

const orderSchema = new mongoose.Schema<IOrder>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true, // buyers look up "my orders" by user ID frequently
    },

    totalPrice: {
      type: Number,
      required: [true, 'Total price is required'],
      min: [0, 'Total price cannot be negative'],
      // This is the FULL amount the buyer sees and is charged.
      // = sum of (OrderItem.priceAtPurchase * OrderItem.quantity) for all items
    },

    platformFee: {
      type: Number,
      required: [true, 'Platform fee is required'],
      min: [0, 'Platform fee cannot be negative'],
      // = totalPrice * platformFeeRate (e.g. 0.10)
      // You keep this; the rest goes to vendors via Stripe Transfers.
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'partially_refunded', 'refunded'],
      default: 'pending',
      // Flow:
      //   pending → paid         (via payment_intent.succeeded webhook)
      //   paid    → partially_refunded  (if one item is refunded)
      //   paid    → refunded     (if full order is refunded)
      //   pending → failed       (via payment_intent.payment_failed webhook)
    },

    orderStatus: {
      type: String,
      enum: ['processing', 'confirmed', 'partially_shipped', 'shipped', 'delivered', 'cancelled'],
      default: 'processing',
    },

    shippingAddress: {
      type: addressSchema,
      required: true,
      // Snapshot of the delivery address at order time.
      // Never reference a user's current address — it may change.
    },

    stripePaymentIntentId: {
      type: String,
      required: [true, 'Stripe PaymentIntent ID is required'],
      unique: true, // one PaymentIntent per order, prevents duplicates
      // Format: "pi_3ABC..."
    },

    stripeChargeId: {
      type: String,
      // Format: "ch_3ABC..." or "py_3ABC..." for PaymentIntent charges
      // Populated via webhook after payment succeeds.
      // Required for refunds: stripe.refunds.create({ charge: stripeChargeId })
    },
  },
  {
    timestamps: true,
  }
);

// ─────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────

// Admin / support queries: find orders by payment or order status
orderSchema.index({ paymentStatus: 1, orderStatus: 1 });

// Stripe webhook lookup: match incoming event to an Order
// Note: Index already created by unique: true on stripePaymentIntentId field

// ─────────────────────────────────────────────
// MODEL EXPORT
// ─────────────────────────────────────────────

const Order = mongoose.model<IOrder>('Order', orderSchema);

export default Order;
