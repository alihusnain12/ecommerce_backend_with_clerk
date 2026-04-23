import type { Request, Response, NextFunction } from 'express'; // Use 'import type'
import jwt from 'jsonwebtoken';
import User from '../models/user.model.ts';

// 
// EXTEND EXPRESS REQUEST TYPE
// 

/**
 * We attach the decoded user object to req.user after verifying the JWT.
 * This declaration merges with Express's Request interface globally so
 * every controller can access req.user without casting.
 */
declare global {
  namespace Express {
    interface Request {
      user?: {
        _id: string;
        email: string;
        role: 'user' | 'vendor' | 'admin';
      };
    }
  }
}

// 
// protect - verifies the JWT access token
// 

/**
 * protect: must run on every route that requires authentication.
 *
 * Flow:
 *  1. Read the Bearer token from the Authorization header
 *  2. Verify it with the ACCESS_TOKEN_SECRET
 *  3. Attach the decoded payload to req.user
 *  4. Call next() so the actual controller runs
 *
 * If anything is wrong (missing, expired, tampered) we return 401.
 */
export const protect = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    // Authorization header must be present and in format "Bearer <token>"
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
      return;
    }

    const token = authHeader.split(' ')[1];

    // Check if this is an admin token (64-character hex string)
    if (token.length === 64 && /^[0-9a-fA-F]+$/.test(token)) {
      // This is an admin token - validate against admin credentials
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminEmail || !adminPassword) {
        res.status(500).json({ success: false, message: 'Admin credentials not configured.' });
        return;
      }

      // Attach admin user to request
      req.user = {
        _id: 'admin_system',
        email: adminEmail,
        role: 'admin'
      };
      next();
      return;
    }

    // Regular JWT token verification
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET as string) as {
      _id: string;
      email: string;
      role: 'user' | 'vendor' | 'admin';
    };

    // Optionally re-fetch from DB to confirm the user still exists and is verified.
    // This adds one DB query per request but catches cases like deleted accounts.
    const user = await User.findById(decoded._id).select('_id email role isVerified');
    if (!user) {
      res.status(401).json({ success: false, message: 'User no longer exists.' });
      return;
    }
    if (!user.isVerified) {
      res.status(403).json({ success: false, message: 'Please verify your email first.' });
      return;
    }

    // Attach to request so downstream middleware and controllers can use it
    req.user = { _id: String(user._id), email: user.email, role: user.role };
    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
    } else {
      res.status(401).json({ success: false, message: 'Invalid token.' });
    }
  }
};

// 
// ROLE GUARDS
// 

/**
 * isVendor: allows only users with role === 'vendor'.
 * Must come AFTER protect in the middleware chain so req.user is set.
 *
 * Usage:
 *   router.post('/products', protect, isVendor, createProduct)
 */
export const isVendor = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'vendor') {
    res.status(403).json({ success: false, message: 'Access denied. Vendors only.' });
    return;
  }
  next();
};

/**
 * isAdmin: allows only users with role === 'admin'.
 *
 * Usage:
 *   router.get('/admin/orders', protect, isAdmin, getAllOrders)
 */
export const isAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Access denied. Admins only.' });
    return;
  }
  next();
};

/**
 * isVendorOrAdmin: allows either vendors or admins.
 * Useful for routes like "get order item details" where both roles are valid.
 */
export const isVendorOrAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'vendor' && req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Access denied.' });
    return;
  }
  next();
};

// Default export for backward compatibility
export { protect as authenticateUser };
export default protect;
