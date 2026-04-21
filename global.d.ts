import type { Request, Response, NextFunction } from 'express';

declare global {
   namespace Express {
      interface Request {
         user?: IAuthUser;
      }
   }

   // Auth & User Types
   interface IAuthUser {
      id: string;
      _id?: string;
      email?: string;
      role?: 'user' | 'vendor' | 'admin';
      name?: string;
   }

   interface IUser {
      _id: string;
      name: string;
      email: string;
      password?: string;
      role: 'user' | 'vendor' | 'admin';
      otp?: string;
      otpExpiry?: Date;
      isVerified: boolean;
      refreshToken?: string;
      clerkId?: string;
      createdAt?: Date;
      updatedAt?: Date;
   }

   // Token Types
   interface ITokenPayload {
      _id: string;
      email: string;
      role: 'user' | 'admin';
      iat?: number;
      exp?: number;
   }

   interface IRefreshTokenPayload {
      _id: string;
      iat?: number;
      exp?: number;
   }

   interface ITokenBlocklist {
      _id: string;
      token: string;
      createdAt?: Date;
      expiresAt?: Date;
   }

   // Request/Response Types
   interface IApiResponse<T = any> {
      statusCode: number;
      data: T;
      message: string;
      success: boolean;
   }

   interface IApiError {
      statusCode: number;
      message: string;
      errors?: any[];
      success: boolean;
   }

   // Request Body Types
   interface IRegisterPayload {
      name: string;
      email: string;
      password: string;
   }

   interface IVerifyOtpPayload {
      email: string;
      otp: string;
   }

   interface ILoginPayload {
      email: string;
      password: string;
   }

   interface IOtpEmailPayload {
      email: string;
      otp: string;
   }

   // Handler Types
   type IAsyncHandler = (
      req: Request,
      res: Response,
      next?: NextFunction
   ) => Promise<any>;

   type IMiddleware = (
      req: Request,
      res: Response,
      next: NextFunction
   ) => void | Promise<void>;

   // Controller Response Types
   interface IAuthResponse {
      accessToken: string;
      refreshToken: string;
      user?: Partial<IUser>;
   }

   interface IRegisterResponse {
      userId: string;
   }

   interface IUserResponse extends Partial<IUser> {
      _id: string;
      name: string;
      email: string;
      role: 'user' | 'admin';
      isVerified: boolean;
   }
}

export {};