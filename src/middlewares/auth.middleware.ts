import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import TokenBlocklist from '../models/tokenBlocklist.model.ts';

const authenticateUser = async (
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> => {
   try {
      // Support both cookie-based and header-based Bearer token
      const authHeader: string | undefined =
         req.cookies?.Authorization ?? req.headers['authorization'];

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
         res.status(401).json({ message: 'Unauthorized: No token provided' });
         return;
      }

      const token = authHeader.split(' ')[1];

      // Check if token has been invalidated (logged out)
      const isBlocked = await TokenBlocklist.findOne({ token });
      if (isBlocked) {
         res.status(401).json({
            message: 'Unauthorized: Token has been invalidated',
         });
         return;
      }

      // Verify and decode — cast to global ITokenPayload
      const decoded = jwt.verify(
         token,
         process.env.ACCESS_TOKEN_SECRET! // must match the secret used in generateAccessToken()
      ) as ITokenPayload;

      // Attach user info to request using the global IAuthUser shape
      req.user = {
         id: decoded._id,
         _id: decoded._id,
         email: decoded.email,
         role: decoded.role,
      };

      next();
   } catch (error) {
      res.status(401).json({
         message: 'Unauthorized: Invalid or expired token',
      });
   }
};

export default authenticateUser;
