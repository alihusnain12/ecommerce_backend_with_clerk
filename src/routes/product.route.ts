import { Router } from 'express';
import {
  createProduct,
  getAllProducts,
  getProductById,
  getMyProducts,
  updateProduct,
  deleteProduct,
  adminGetAllProducts,
} from '../controllers/product.controller.ts';
import { protect, isVendor, isAdmin } from '../middlewares/auth.middleware.ts';
import { multerUpload } from '../config/cloudinary.ts';

// ─────────────────────────────────────────────
// PRODUCT ROUTER
// ─────────────────────────────────────────────

/**
 * Base path: /api/products
 *
 * Middleware order matters:
 *   protect        → verifies JWT, sets req.user
 *   isVendor       → checks req.user.role === 'vendor'
 *   isAdmin        → checks req.user.role === 'admin'
 *   multerUpload   → parses multipart/form-data, uploads images to Cloudinary
 *                    MUST come before the controller so req.files is populated
 */
const router = Router();

// ─────────────────────────────────────────────
// PUBLIC ROUTES — no authentication required
// ─────────────────────────────────────────────

// GET /api/products
// Browse all active products with search, filter, and pagination
// ?search=shirt&category=clothing&minPrice=10&maxPrice=100&page=1&limit=12&sort=price_asc
router.get('/', getAllProducts);

// ─────────────────────────────────────────────
// VENDOR ROUTES — requires vendor role
// ─────────────────────────────────────────────

// GET /api/products/my-products
// Vendor sees all their own listings (active + inactive)
// ?status=active|inactive&page=1&limit=20
router.get('/my-products', protect, isVendor, getMyProducts);

// GET /api/products/:id
// Get a single product's full details
router.get('/:id', getProductById);

// POST /api/products
// Create a new product with image uploads
// Body: multipart/form-data with fields: name, description, price, category, stock,
//        colors (comma-separated), sizes (comma-separated), images (up to 5 files)
router.post(
  '/',
  protect,
  isVendor,
  multerUpload.array('images', 5), // 'images' = the form field name, 5 = max files
  createProduct
);

// PUT /api/products/:id
// Update a product — new images are optional (existing kept if none uploaded)
// Body: same fields as POST, all optional
router.put(
  '/:id',
  protect,
  isVendor,
  multerUpload.array('images', 5),
  updateProduct
);

// DELETE /api/products/:id
// Soft-delete: sets isActive = false, removes images from Cloudinary
router.delete('/:id', protect, isVendor, deleteProduct);

// ─────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────

// GET /api/products/admin/all
// All products including inactive, optionally filtered by vendor
// ?vendorId=xxx&page=1&limit=20
router.get('/admin/all', protect, isAdmin, adminGetAllProducts);

export default router;