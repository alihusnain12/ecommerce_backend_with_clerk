import type { Request, Response } from 'express';
import Product from '../models/product.model.ts';
import { deleteFromCloudinary, extractPublicId } from '../config/cloudinary.ts';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

/**
 * When multer runs before this controller, it attaches uploaded file info
 * to req.files. Each file object from CloudinaryStorage includes a path
 * field which holds the full Cloudinary secure URL we store in the DB.
 */
interface CloudinaryFile extends Express.Multer.File {
  path: string; // Cloudinary secure_url — e.g. "https://res.cloudinary.com/..."
}

// ─────────────────────────────────────────────
// CREATE PRODUCT
// POST /api/products
// Access: vendor only
// ─────────────────────────────────────────────

/**
 * createProduct: a vendor uploads a new product with images.
 *
 * Multer (with CloudinaryStorage) runs BEFORE this function and:
 *  1. Accepts the multipart/form-data request
 *  2. Streams each image file directly to Cloudinary
 *  3. Populates req.files[] with metadata including the Cloudinary URL (file.path)
 *
 * We extract those URLs and store them in product.images[].
 */
export const createProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, price, category, stock, colors, sizes } = req.body;

    // req.files is populated by multer after successful Cloudinary upload
    // Cast to our extended type so TypeScript knows about .path
    const files = req.files as CloudinaryFile[];

    // Guard: at least one image is required
    if (!files || files.length === 0) {
      res.status(400).json({ success: false, message: 'At least one product image is required.' });
      return;
    }

    // Extract the Cloudinary secure URLs from the uploaded file objects
    // file.path = the full HTTPS URL Cloudinary returned after upload
    const imageUrls = files.map((file) => file.path);

    // Parse colors and sizes — they may arrive as comma-separated strings
    // from a form, or as arrays from a JSON body.
    const parsedColors = Array.isArray(colors)
      ? colors
      : colors
      ? colors.split(',').map((c: string) => c.trim())
      : [];

    const parsedSizes = Array.isArray(sizes)
      ? sizes
      : sizes
      ? sizes.split(',').map((s: string) => s.trim())
      : [];

    const product = await Product.create({
      name,
      description,
      price: Number(price),
      category,
      stock: Number(stock),
      images: imageUrls,
      vendor: req.user!._id, // set from the authenticated vendor's JWT payload
      colors: parsedColors,
      sizes: parsedSizes,
    });

    res.status(201).json({
      success: true,
      message: 'Product created successfully.',
      data: product,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// GET ALL PRODUCTS (public browse / search)
// GET /api/products
// Access: public
// ─────────────────────────────────────────────

/**
 * getAllProducts: supports category filtering, full-text search,
 * and pagination so buyers can browse the marketplace.
 *
 * Query params:
 *   ?search=shirt      → full-text search (uses the text index)
 *   ?category=shoes    → filter by category
 *   ?minPrice=10       → price range filter
 *   ?maxPrice=100
 *   ?page=1            → pagination (default page 1)
 *   ?limit=12          → items per page (default 12)
 *   ?sort=price_asc    → sort: price_asc | price_desc | newest | rating
 */
export const getAllProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, category, minPrice, maxPrice, page = 1, limit = 12, sort } = req.query;

    // Build the MongoDB filter object incrementally
    const filter: Record<string, any> = {
      isActive: true, // ALWAYS exclude deactivated products from public view
    };

    // Full-text search uses the { name, description, category } text index
    // $text + $search is far more efficient than a regex scan on large collections
    if (search) {
      filter.$text = { $search: String(search) };
    }

    if (category) {
      filter.category = String(category);
    }

    // Price range filter: only add the clause for the bounds that were provided
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // Build the sort object
    // 'newest' is the default — buyers usually want to see new listings first
    const sortMap: Record<string, Record<string, any>> = {
      price_asc: { price: 1 },
      price_desc: { price: -1 },
      newest: { createdAt: -1 },
      rating: { averageRating: -1 },
    };
    const sortOption = sortMap[String(sort)] ?? { createdAt: -1 };

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    // Run the query and the count in parallel to avoid two sequential round trips
    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('vendor', 'name email') // show vendor name on product cards
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum)
        .lean(), // .lean() returns plain JS objects, faster for read-only responses
      Product.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: products,
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        limit: limitNum,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// GET SINGLE PRODUCT
// GET /api/products/:id
// Access: public
// ─────────────────────────────────────────────

export const getProductById = async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('vendor', 'name email stripeOnboardingComplete'); // don't expose stripeAccountId

    if (!product || !product.isActive) {
      res.status(404).json({ success: false, message: 'Product not found.' });
      return;
    }

    res.status(200).json({ success: true, data: product });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// GET VENDOR'S OWN PRODUCTS
// GET /api/products/my-products
// Access: vendor only
// ─────────────────────────────────────────────

/**
 * getMyProducts: returns all products belonging to the authenticated vendor,
 * including inactive ones (so they can see and reactivate deactivated listings).
 */
export const getMyProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    const filter: Record<string, any> = { vendor: req.user!._id };

    // Vendor can filter by active/inactive from their dashboard
    if (status === 'active') filter.isActive = true;
    if (status === 'inactive') filter.isActive = false;

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
      Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Product.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: products,
      pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// UPDATE PRODUCT
// PUT /api/products/:id
// Access: vendor only (must own the product)
// ─────────────────────────────────────────────

/**
 * updateProduct: allows a vendor to update text fields and optionally
 * replace images.
 *
 * Image update strategy:
 *  - If new images are uploaded (req.files has items), we DELETE the old
 *    images from Cloudinary and store the new URLs.
 *  - If no new images are uploaded, existing images are kept unchanged.
 *
 * This prevents orphaned images accumulating in your Cloudinary account.
 */
export const updateProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      res.status(404).json({ success: false, message: 'Product not found.' });
      return;
    }

    // Ownership check: only the vendor who created this product can edit it
    // (admins can bypass — add isAdmin check if you want that)
    if (product.vendor.toString() !== req.user!._id) {
      res.status(403).json({ success: false, message: 'You do not own this product.' });
      return;
    }

    const { name, description, price, category, stock, colors, sizes, isActive } = req.body;
    const files = req.files as CloudinaryFile[];

    // ── Handle image replacement ────────────────────────────────
    let imageUrls = product.images; // default: keep existing images

    if (files && files.length > 0) {
      // Step 1: Delete old images from Cloudinary to avoid orphaned storage costs
      // We do this BEFORE updating the DB so if Cloudinary fails we haven't
      // lost the references yet (though in practice, partial failure here is
      // recoverable since the DB still has the old URLs).
      const deletePromises = product.images.map((url) =>
        deleteFromCloudinary(extractPublicId(url))
      );
      await Promise.all(deletePromises);

      // Step 2: Use the new URLs from the freshly uploaded files
      imageUrls = files.map((file) => file.path);
    }

    // Parse array fields that may come as comma-separated strings
    const parsedColors = colors
      ? Array.isArray(colors)
        ? colors
        : colors.split(',').map((c: string) => c.trim())
      : product.colors;

    const parsedSizes = sizes
      ? Array.isArray(sizes)
        ? sizes
        : sizes.split(',').map((s: string) => s.trim())
      : product.sizes;

    // Apply updates — only overwrite fields that were actually provided
    product.name = name ?? product.name;
    product.description = description ?? product.description;
    product.price = price !== undefined ? Number(price) : product.price;
    product.category = category ?? product.category;
    product.stock = stock !== undefined ? Number(stock) : product.stock;
    product.colors = parsedColors;
    product.sizes = parsedSizes;
    product.images = imageUrls;
    product.isActive = isActive !== undefined ? Boolean(isActive) : product.isActive;

    await product.save();

    res.status(200).json({ success: true, message: 'Product updated.', data: product });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// DELETE PRODUCT (soft delete)
// DELETE /api/products/:id
// Access: vendor only (must own the product)
// ─────────────────────────────────────────────

/**
 * deleteProduct: sets isActive = false (soft delete).
 *
 * Why soft delete instead of actually removing the document?
 *  - OrderItems reference this product by _id for historical records.
 *  - If we hard-delete, those references become dangling and order history breaks.
 *  - isActive = false hides the product from buyers but keeps it queryable
 *    by the order system.
 *
 * We DO delete the images from Cloudinary on soft-delete to free up storage,
 * since the product is no longer visible anyway.
 */
export const deleteProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      res.status(404).json({ success: false, message: 'Product not found.' });
      return;
    }

    if (product.vendor.toString() !== req.user!._id) {
      res.status(403).json({ success: false, message: 'You do not own this product.' });
      return;
    }

    // Delete images from Cloudinary
    const deletePromises = product.images.map((url) =>
      deleteFromCloudinary(extractPublicId(url))
    );
    await Promise.all(deletePromises);

    // Soft delete — keep the document for order history integrity
    product.isActive = false;
    await product.save();

    res.status(200).json({ success: true, message: 'Product deactivated and images removed.' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// ADMIN: GET ALL PRODUCTS (including inactive)
// GET /api/products/admin/all
// Access: admin only
// ─────────────────────────────────────────────

export const adminGetAllProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 20, vendorId } = req.query;

    const filter: Record<string, any> = {};
    if (vendorId) filter.vendor = vendorId; // admin can filter by specific vendor

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('vendor', 'name email stripeOnboardingComplete')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: products,
      pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};