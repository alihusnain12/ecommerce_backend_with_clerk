import { verifyToken } from '@clerk/express'; // use @clerk/express to avoid duplicate identifiers
import type { Request, Response, NextFunction } from 'express';

// Extend Request interface to include clerkId
declare global {
   namespace Express {
      interface Request {
         clerkId?: string;
         clerkToken?: string;
      }
   }
}

const verifyClerkToken = async (
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> => {
   try {
      const authHeader: string | undefined =
         req.cookies?.Authorization ?? req.headers['authorization'];

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
         res.status(401).json({ message: 'Unauthorized: No token provided' });
         return;
      }

      const token = authHeader.split(' ')[1];

      const payload = await verifyToken(token, {
         secretKey: process.env.CLERK_SECRET_KEY!,
      } as any);

      if (!payload?.sub) {
         res.status(401).json({ message: 'Unauthorized: Invalid Clerk token' });
         return;
      }

      req.clerkId = payload.sub;
      req.clerkToken = token;

      next();
   } catch (error) {
      res.status(401).json({
         message: 'Unauthorized: Clerk token verification failed',
      });
   }
};

export default verifyClerkToken;
