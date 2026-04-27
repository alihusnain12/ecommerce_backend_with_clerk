import { Router } from 'express';
import {
  checkout,
  handleStripeWebhook,
  getMyOrders,
  getOrderById,
  getVendorOrderItems,
  updateItemStatus,
  adminGetAllOrders,
  refundOrderItem,
} from '../controllers/order.controller';
import { protect, isVendor, isAdmin } from '../middlewares/auth.middleware';
import express from 'express';

// ─────────────────────────────────────────────
// ORDER ROUTER
// ─────────────────────────────────────────────

/**
 * Base path: /api/orders
 *
 * CRITICAL — Stripe webhook setup:
 * The /webhook route MUST receive the raw request body (Buffer),
 * NOT the parsed JSON body, so Stripe can verify the signature.
 *
 * In your main app.ts, mount this router BEFORE express.json():
 *
 *   import orderRouter from './routes/order.routes';
 *
 *   // Raw body parser for Stripe webhook — must be before express.json()
 *   app.use('/api/orders/webhook',
 *     express.raw({ type: 'application/json' }),
 *     (req, res, next) => { orderRouter(req, res, next); }
 *   );
 *
 *   // JSON body parser for all other routes
 *   app.use(express.json());
 *   app.use('/api/orders', orderRouter);
 *
 * Alternatively, register the webhook route directly in app.ts:
 *   app.post('/api/orders/webhook',
 *     express.raw({ type: 'application/json' }),
 *     handleStripeWebhook
 *   );
 */
const router = Router();

// ─────────────────────────────────────────────
// STRIPE WEBHOOK — raw body required
// ─────────────────────────────────────────────

// POST /api/orders/webhook
// Receives payment_intent.succeeded and payment_intent.payment_failed from Stripe.
// express.raw() is applied here as a route-level middleware as an alternative
// to setting it up globally in app.ts.
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }), // must be before any json parsing
  handleStripeWebhook
);

// ─────────────────────────────────────────────
// BUYER ROUTES
// ─────────────────────────────────────────────

// POST /api/orders/checkout
// Creates an Order + OrderItems + Stripe PaymentIntent.
// Returns clientSecret for frontend Stripe.js to complete payment.
// Body: { cartItems: [{ productId, quantity, selectedColor?, selectedSize? }], shippingAddress }
router.post('/checkout', protect, checkout);

// GET /api/orders/my-orders
// Buyer's order history with items attached
// ?page=1&limit=10
router.get('/my-orders', protect, getMyOrders);

// GET /api/orders/:id
// Single order full detail — buyer can only fetch their own orders
router.get('/:id', protect, getOrderById);

// ─────────────────────────────────────────────
// VENDOR ROUTES
// ─────────────────────────────────────────────

// GET /api/orders/vendor/items
// All order items belonging to the authenticated vendor
// ?status=confirmed|shipped|delivered&page=1&limit=20
router.get('/vendor/items', protect, isVendor, getVendorOrderItems);

// PATCH /api/orders/items/:itemId/status
// Vendor marks their item as shipped or delivered
// Body: { status: 'shipped' | 'delivered' | 'cancelled' }
router.patch('/items/:itemId/status', protect, isVendor, updateItemStatus);

// ─────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────

// GET /api/orders/admin/all
// All orders with optional status filters
// ?paymentStatus=paid&orderStatus=confirmed&page=1&limit=20
router.get('/admin/all', protect, isAdmin, adminGetAllOrders);

// POST /api/orders/items/:itemId/refund
// Admin issues a partial Stripe refund for a single order item
// and reverses the vendor's transfer
router.post('/items/:itemId/refund', protect, isAdmin, refundOrderItem);

export default router;