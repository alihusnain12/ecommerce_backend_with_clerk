import type { Request, Response } from 'express';
import Stripe from 'stripe';
import User from '../models/user.model.ts';
import OrderItem from '../models/orderItem.model.ts';
import Product from '../models/product.model.ts';

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

// ─────────────────────────────────────────────
// BECOME A VENDOR (upgrade role)
// POST /api/vendor/become-vendor
// Access: authenticated user (role = 'user')
// ─────────────────────────────────────────────

/**
 * becomeVendor: upgrades a regular user to vendor role.
 *
 * This is step 1 of vendor onboarding — it just changes the role.
 * Stripe Connect setup happens in the next step (createStripeAccount).
 * We keep these separate so the role change is instant and visible to the user.
 */
export const becomeVendor = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!._id);

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }

    if (user.role === 'vendor') {
      res.status(400).json({ success: false, message: 'You are already a vendor.' });
      return;
    }

    user.role = 'vendor';
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Role upgraded to vendor. Proceed to complete Stripe onboarding.',
      data: { role: user.role },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// CREATE STRIPE CONNECT ACCOUNT
// POST /api/vendor/stripe/create-account
// Access: vendor only
// ─────────────────────────────────────────────

/**
 * createStripeAccount: creates a Stripe Connect Express account for the vendor
 * and returns an onboarding URL they visit to enter their bank details.
 *
 * Stripe Connect Express is the recommended type for marketplaces:
 *  - Stripe hosts the onboarding UI (you don't build forms for KYC/bank details)
 *  - Vendors log in to a Stripe-hosted dashboard to see their payouts
 *  - You handle transfers; Stripe handles compliance
 *
 * Flow:
 *  1. Check if vendor already has a Stripe account (idempotent)
 *  2. Create a Stripe Express account
 *  3. Store the account ID on the User document
 *  4. Generate an Account Link URL for the onboarding flow
 *  5. Return the URL — frontend redirects vendor to it
 */
export const createStripeAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!._id);

    if (!user) {
      res.status(404).json({ success: false, message: 'Vendor not found.' });
      return;
    }

    let stripeAccountId = user.stripeAccountId;

    // Idempotency: if the vendor already has an account ID, don't create a new one.
    // Just regenerate the onboarding link in case it expired (links expire after 24h).
    if (!stripeAccountId) {
      // Mock mode for testing without real Stripe Connect setup
      if (process.env.NODE_ENV === 'development' || process.env.USE_MOCK_STRIPE === 'true') {
        stripeAccountId = 'acct_mock_' + Date.now();
        user.stripeAccountId = stripeAccountId;
        user.stripeOnboardingComplete = true; // Auto-complete for testing
        await user.save();
      } else {
        const account = await getStripe().accounts.create({
          type: 'express',
          email: user.email,
          capabilities: {
            card_payments: { requested: true }, // allow receiving card payments
            transfers: { requested: true },     // allow receiving transfers from platform
          },
          business_type: 'individual', // or 'company' — add to request body if needed
          metadata: {
            userId: String(user._id), // useful for cross-referencing in Stripe dashboard
          },
        });

        stripeAccountId = account.id;
        user.stripeAccountId = stripeAccountId;
        await user.save();
      }
    }

    // AccountLink is the onboarding URL — it expires after 24 hours.
    // The vendor must complete onboarding before this expires.
    let accountLink;
    
    // Mock mode for testing
    if (process.env.NODE_ENV === 'development' || process.env.USE_MOCK_STRIPE === 'true') {
      accountLink = {
        url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/vendor/stripe/mock-complete?accountId=${stripeAccountId}`
      };
    } else {
      accountLink = await getStripe().accountLinks.create({
      account: stripeAccountId,
      // refresh_url: if the link expires, your frontend redirects back here
      // and you re-generate a fresh link (by calling this endpoint again).
      refresh_url: `${process.env.FRONTEND_URL}/vendor/stripe/refresh`,
      // return_url: where Stripe redirects after the vendor completes or skips onboarding
      return_url: `${process.env.FRONTEND_URL}/vendor/stripe/return`,
      type: 'account_onboarding',
    });
    }

    res.status(200).json({
      success: true,
      message: 'Stripe account created. Redirect vendor to the onboarding URL.',
      data: {
        stripeAccountId,
        onboardingUrl: accountLink.url, // frontend does: window.location.href = onboardingUrl
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// STRIPE CONNECT WEBHOOK — account.updated
// POST /api/vendor/stripe/webhook
// Access: Stripe only
// ─────────────────────────────────────────────

/**
 * handleVendorStripeWebhook: listens for Stripe account updates.
 *
 * When a vendor completes onboarding, Stripe fires account.updated.
 * We check if both charges_enabled and payouts_enabled are true,
 * then set stripeOnboardingComplete = true on their User document.
 *
 * This is how we know a vendor can receive payouts — we never trust
 * the vendor to tell us themselves.
 *
 * Same setup as the order webhook — needs express.raw() middleware.
 */
export const handleVendorStripeWebhook = async (req: Request, res: Response): Promise<void> => {
  const sig = req.headers['stripe-signature'] as string;

  let event;

  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET as string
      // Note: use a DIFFERENT webhook secret for Connect webhooks vs. payment webhooks
      // Set this up in Stripe dashboard under "Connect" → "Webhooks"
    );
  } catch (err: any) {
    res.status(400).json({ message: `Webhook error: ${err.message}` });
    return;
  }

  if (event.type === 'account.updated') {
    const account = event.data.object as any;

    // Both must be true before we allow payouts to this vendor
    const isComplete = account.charges_enabled && account.payouts_enabled;

    await User.findOneAndUpdate(
      { stripeAccountId: account.id }, // find the vendor by their Stripe account ID
      { stripeOnboardingComplete: isComplete }
    );
  }

  res.status(200).json({ received: true });
};

// ─────────────────────────────────────────────
// GET STRIPE ONBOARDING STATUS
// GET /api/vendor/stripe/status
// Access: vendor only
// ─────────────────────────────────────────────

/**
 * getStripeStatus: returns the current onboarding state for the vendor.
 * Frontend uses this to show a banner like "Complete your payout setup"
 * if the vendor hasn't finished Stripe onboarding yet.
 */
export const getStripeStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!._id).select(
      'stripeAccountId stripeOnboardingComplete'
    );

    if (!user) {
      res.status(404).json({ success: false, message: 'Vendor not found.' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        hasStripeAccount: !!user.stripeAccountId,
        stripeOnboardingComplete: user.stripeOnboardingComplete,
        // If onboarding is incomplete, the frontend should call createStripeAccount
        // again to get a fresh onboarding link and redirect the vendor.
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// VENDOR DASHBOARD STATS
// GET /api/vendor/dashboard
// Access: vendor only
// ─────────────────────────────────────────────

/**
 * getVendorDashboard: returns key metrics for the vendor's home screen.
 *
 * Uses MongoDB aggregation pipelines for performance — one query per metric
 * instead of fetching all documents and computing in JavaScript.
 */
export const getVendorDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = req.user!._id;

    // Run all aggregations in parallel — they're independent of each other
    const [
      revenueResult,
      pendingCount,
      totalProducts,
      recentItems,
      topProducts,
    ] = await Promise.all([
      // Total earnings: sum vendorPayout for all non-refunded items
      OrderItem.aggregate([
        {
          $match: {
            vendor: vendorId,
            itemStatus: { $in: ['confirmed', 'shipped', 'delivered'] },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$vendorPayout' },
            totalOrders: { $sum: 1 },
          },
        },
      ]),

      // Pending orders: items awaiting action from the vendor
      OrderItem.countDocuments({ vendor: vendorId, itemStatus: 'confirmed' }),

      // Total active product listings
      Product.countDocuments({ vendor: vendorId, isActive: true }),

      // Most recent 5 orders
      OrderItem.find({ vendor: vendorId })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('product', 'name images')
        .populate('order', 'createdAt')
        .lean(),

      // Top 5 best-selling products by quantity sold
      OrderItem.aggregate([
        {
          $match: {
            vendor: vendorId,
            itemStatus: { $in: ['confirmed', 'shipped', 'delivered'] },
          },
        },
        {
          $group: {
            _id: '$product',
            totalQuantitySold: { $sum: '$quantity' },
            totalRevenue: { $sum: '$vendorPayout' },
          },
        },
        { $sort: { totalQuantitySold: -1 } },
        { $limit: 5 },
        {
          // Join with Product collection to get name and images
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: '$product' },
        {
          $project: {
            'product.name': 1,
            'product.images': { $slice: ['$product.images', 1] }, // first image only
            totalQuantitySold: 1,
            totalRevenue: 1,
          },
        },
      ]),
    ]);

    const revenue = revenueResult[0] ?? { totalRevenue: 0, totalOrders: 0 };

    res.status(200).json({
      success: true,
      data: {
        totalRevenue: revenue.totalRevenue,
        totalOrderItems: revenue.totalOrders,
        pendingItems: pendingCount,
        totalActiveProducts: totalProducts,
        recentOrders: recentItems,
        topProducts,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// ADMIN: GET ALL VENDORS
// GET /api/vendor/admin/all
// Access: admin only
// ─────────────────────────────────────────────

export const adminGetAllVendors = async (req: Request, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 20, onboardingStatus } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, any> = { role: 'vendor' };

    // Filter by Stripe onboarding completion status if requested
    if (onboardingStatus === 'complete') filter.stripeOnboardingComplete = true;
    if (onboardingStatus === 'incomplete') filter.stripeOnboardingComplete = false;

    const [vendors, total] = await Promise.all([
      User.find(filter)
        .select('name email stripeOnboardingComplete stripeAccountId createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: vendors,
      pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};