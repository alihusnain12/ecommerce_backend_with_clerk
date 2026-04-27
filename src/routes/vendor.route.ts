import { Router } from 'express';
import {
  becomeVendor,
  createStripeAccount,
  handleVendorStripeWebhook,
  getStripeStatus,
  getVendorDashboard,
  adminGetAllVendors,
} from '../controllers/vendor.controller';
import { protect, isVendor, isAdmin } from '../middlewares/auth.middleware';
import express from 'express';

// ─────────────────────────────────────────────
// VENDOR ROUTER
// ─────────────────────────────────────────────

/**
 * Base path: /api/vendor
 *
 * Vendor onboarding flow:
 *  1. POST /api/vendor/become-vendor         → upgrade role from 'user' to 'vendor'
 *  2. POST /api/vendor/stripe/create-account → create Stripe Express account, get onboarding URL
 *  3. [Vendor visits Stripe-hosted onboarding page in browser]
 *  4. Stripe fires account.updated webhook  → we set stripeOnboardingComplete = true
 *  5. GET  /api/vendor/stripe/status         → frontend confirms onboarding is done
 */
const router = Router();

// ─────────────────────────────────────────────
// STRIPE CONNECT WEBHOOK — raw body required
// ─────────────────────────────────────────────

// POST /api/vendor/stripe/webhook
// Stripe fires account.updated when a vendor completes (or partially completes) onboarding.
// Uses a DIFFERENT webhook secret from the payment webhook — set STRIPE_CONNECT_WEBHOOK_SECRET in .env
router.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }), // raw body needed for signature verification
  handleVendorStripeWebhook
);

// ─────────────────────────────────────────────
// VENDOR ONBOARDING ROUTES
// ─────────────────────────────────────────────

// POST /api/vendor/become-vendor
// Any authenticated user can request to become a vendor.
// Changes role from 'user' → 'vendor'.
router.post('/become-vendor', protect, becomeVendor);

// POST /api/vendor/stripe/create-account
// Creates (or re-uses existing) Stripe Express account.
// Returns onboarding URL — frontend redirects vendor to it.
// If the vendor's link expired, calling this again generates a fresh one.
router.post('/stripe/create-account', protect, isVendor, createStripeAccount);

// GET /api/vendor/stripe/status
// Frontend polls this to check if vendor has finished Stripe onboarding.
// Returns: { hasStripeAccount: bool, stripeOnboardingComplete: bool }
router.get('/stripe/status', protect, isVendor, getStripeStatus);

// ─────────────────────────────────────────────
// VENDOR DASHBOARD ROUTES
// ─────────────────────────────────────────────

// GET /api/vendor/dashboard
// Returns revenue, pending items, active listings, recent orders, top products
router.get('/dashboard', protect, isVendor, getVendorDashboard);

// ─────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────

// GET /api/vendor/admin/all
// List all vendors with their Stripe onboarding status
// ?onboardingStatus=complete|incomplete&page=1&limit=20
router.get('/admin/all', protect, isAdmin, adminGetAllVendors);

export default router;