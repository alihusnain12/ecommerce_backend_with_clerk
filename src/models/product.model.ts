import mongoose from 'mongoose';

// ─────────────────────────────────────────────
// INTERFACE
// ─────────────────────────────────────────────

/**
 * IProduct defines the shape of a product document.
 *
 * Each product belongs to exactly ONE vendor (a User with role 'vendor').
 * When a buyer adds products from multiple vendors to their cart, the
 * vendor field on each product tells us which Stripe account to pay later.
 */
export interface IProduct extends mongoose.Document {
  name: string;
  description: string;

  // Current listed price — used for display in the storefront.
  // IMPORTANT: when an order is placed, copy this into OrderItem.priceAtPurchase
  // so that future price changes don't affect historical orders.
  price: number;

  category: string;
  stock: number;        // decremented on purchase, checked before checkout
  images: string[];     // array of image URLs (S3, Cloudinary, etc.)

  // The vendor who owns this product.
  // Populated from the User collection (role = 'vendor').
  // Used to:
  //  1. Show vendor info on the product page
  //  2. Denormalise into OrderItem.vendor at checkout time
  //  3. Route Stripe transfers to the correct account
  vendor: mongoose.Types.ObjectId;

  colors?: string[];    // e.g. ['red', 'blue', 'black']
  sizes?: string[];     // e.g. ['S', 'M', 'L', 'XL']

  // Soft-delete flag — lets vendors deactivate products without
  // destroying order history that references them.
  isActive: boolean;

  // Average star rating (0–5), updated whenever a review is submitted.
  // Storing it here avoids a slow aggregation query on every product listing.
  averageRating: number;
  reviewCount: number;
}

// ─────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────

const productSchema = new mongoose.Schema<IProduct>(
  {
    name: {
      type: String,
      required: [true, 'Please enter product name'],
      trim: true,
    },

    description: {
      type: String,
      required: [true, 'Please enter product description'],
    },

    price: {
      type: Number,
      required: [true, 'Please enter product price'],
      min: [0, 'Price cannot be negative'],
    },

    category: {
      type: String,
      required: [true, 'Please enter product category'],
      trim: true,
      // Tip: consider a separate Category collection or a strict enum
      // so categories are consistent across vendors.
    },

    stock: {
      type: Number,
      required: [true, 'Please enter product stock'],
      min: [0, 'Stock cannot be negative'],
      // When placing an order, check stock >= requested quantity BEFORE
      // creating the Stripe PaymentIntent. Decrement it in the same
      // DB transaction (or use optimistic locking) to avoid overselling.
    },

    images: [
      {
        type: String,
        trim: true,
        // Store fully-qualified URLs (e.g. https://cdn.example.com/img.jpg)
        // not relative paths, so they work across environments.
      },
    ],

    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',       // joins to the User collection
      required: [true, 'Vendor ID is required'],
      index: true,       // vendors query "my products" frequently — index speeds this up
    },

    colors: [
      {
        type: String,
        trim: true,
      },
    ],

    sizes: [
      {
        type: String,
        trim: true,
      },
    ],

    isActive: {
      type: Boolean,
      default: true,
      // Always filter by isActive: true in public-facing product queries
      // so deactivated products are invisible to buyers.
    },

    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    reviewCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

// ─────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────

// Text index for search — buyers can search by name, description, category
productSchema.index({ name: 'text', description: 'text', category: 'text' });

// Vendor + active: the most common query pattern for vendor dashboards
productSchema.index({ vendor: 1, isActive: 1 });

// Category browsing with sorting by price
productSchema.index({ category: 1, price: 1 });

// ─────────────────────────────────────────────
// MODEL EXPORT
// ─────────────────────────────────────────────

const Product = mongoose.model<IProduct>('Product', productSchema);

export default Product;