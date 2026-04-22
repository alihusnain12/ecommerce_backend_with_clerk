import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';
import dotenv from 'dotenv';
dotenv.config();
// ─────────────────────────────────────────────
// CLOUDINARY CONFIGURATION
// ─────────────────────────────────────────────

/**
 * Configure Cloudinary with credentials from environment variables.
 * These are set in your .env file:
 *   CLOUDINARY_CLOUD_NAME=your_cloud_name
 *   CLOUDINARY_API_KEY=your_api_key
 *   CLOUDINARY_API_SECRET=your_api_secret
 *
 * Never hardcode these — they give full read/write/delete access to your account.
 */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─────────────────────────────────────────────
// MULTER + CLOUDINARY STORAGE
// ─────────────────────────────────────────────

/**
 * CloudinaryStorage is a multer storage engine that pipes uploaded files
 * directly from the request stream to Cloudinary — no temp files on disk.
 *
 * This means:
 *  - Files never touch your server's filesystem
 *  - Works on serverless / read-only filesystems (Vercel, Railway, etc.)
 *  - Cloudinary returns a secure_url we store in product.images[]
 */
const productStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    // Organise uploads into a folder per vendor so the Cloudinary
    // dashboard stays clean and you can scope asset management.
    folder: `multivendor/products/${(req as any).user?._id ?? 'unknown'}`,

    // allowed_formats restricts what file types reach Cloudinary.
    // Reject anything that isn't an image at the storage level.
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],

    // transformation: resize & compress on upload so we never store
    // massive originals.  width/height are maximum dimensions (crop: 'limit'
    // scales down proportionally, never up).
    transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
  }),
});

/**
 * multerUpload is the middleware you attach to product routes.
 * .array('images', 5) means:
 *   - field name in the form must be 'images'
 *   - maximum 5 images per product upload
 *
 * Usage in routes:
 *   router.post('/', protect, isVendor, multerUpload.array('images', 5), createProduct)
 */
export const multerUpload = multer({
  storage: productStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB per file — reject oversized uploads before hitting Cloudinary
  },
  fileFilter: (req, file, cb) => {
    // Double-check MIME type on the Node side (CloudinaryStorage also checks extension)
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ─────────────────────────────────────────────
// CLOUDINARY HELPERS
// ─────────────────────────────────────────────

/**
 * deleteFromCloudinary: removes an image by its public_id.
 *
 * When should you call this?
 *  1. When a vendor deletes a product → delete all its images
 *  2. When a vendor updates a product and replaces an image → delete the old one
 *
 * The public_id is embedded in the Cloudinary URL:
 *   https://res.cloudinary.com/<cloud>/image/upload/v123/<public_id>.jpg
 * or you can extract it with extractPublicId() below.
 */
export const deleteFromCloudinary = async (publicId: string): Promise<void> => {
  await cloudinary.uploader.destroy(publicId);
};

/**
 * extractPublicId: parses a full Cloudinary URL and returns just the public_id
 * portion (folder + filename without extension).
 *
 * Example:
 *   input:  "https://res.cloudinary.com/demo/image/upload/v1234/multivendor/products/abc123/xyz.jpg"
 *   output: "multivendor/products/abc123/xyz"
 *
 * This is needed because Product.images[] stores full URLs, but
 * cloudinary.uploader.destroy() takes only the public_id.
 */
export const extractPublicId = (cloudinaryUrl: string): string => {
  // Split on '/upload/' to isolate the path after the upload keyword
  const parts = cloudinaryUrl.split('/upload/');
  if (parts.length < 2) return '';

  // The second part looks like: "v1234567890/folder/filename.jpg"
  // We strip the version prefix (v + digits + /) and the file extension
  const withVersion = parts[1];
  const withoutVersion = withVersion.replace(/^v\d+\//, ''); // remove "v1234/"
  const withoutExtension = withoutVersion.replace(/\.[^/.]+$/, ''); // remove ".jpg"
  return withoutExtension;
};

export default cloudinary;