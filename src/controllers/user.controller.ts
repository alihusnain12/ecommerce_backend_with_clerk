import User from '../models/user.model.ts';
import PendingRegistration from '../models/pendingRegistration.model.ts';
import { ApiError } from '../utils/ApiError.ts';
import { asyncHandler } from '../utils/asyncHandler.ts';
import { ApiResponse } from '../utils/ApiResponse.ts';
import { sendOtpEmail } from '../utils/sendOtp.ts';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import TokenBlocklist from '../models/tokenBlocklist.model.ts';
import { clerkClient, getAuth } from '@clerk/express';

// ─── Token helpers ─────────────────────────────────────────────────────────────
const generateAccessAndRefreshTokens = async (userId: string) => {
   try {
      const user = await User.findById(userId);
      if (!user) throw new ApiError(404, 'User not found');

      const accessToken = user.generateAccessToken();
      const refreshToken = user.generateRefreshToken();

      user.refreshToken = refreshToken;
      await user.save({ validateBeforeSave: false });

      return { accessToken, refreshToken };
   } catch {
      throw new ApiError(500, 'Something went wrong while generating refresh and access token');
   }
};

/**
 * @desc    Register a new user (stores in DB temporarily — not verified yet)
 * @route   POST /api/users/register
 * @access  Public
 */
const registerUser = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const { name, email, password, role } = req.body;

      if (!name || !email || !password || !role) {
         throw new ApiError(400, 'Name, email, password, and role are required');
      }

      if (!['user', 'vendor'].includes(role)) {
         throw new ApiError(400, 'Invalid role. Must be user or vendor');
      }

      // Check if already a verified user
      const existingUser = await User.findOne({ email });
      if (existingUser) {
         throw new ApiError(400, 'User already exists');
      }

      const otp = crypto.randomInt(100000, 999999).toString();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

      // Upsert into DB — safe across server restarts and hot-reloads
      await PendingRegistration.findOneAndUpdate(
         { email },
         { name, email, hashedPassword: password, otp, otpExpiry, role },
         { upsert: true, new: true }
      );

      await sendOtpEmail(email, otp);

      return res.json(
         new ApiResponse(200, { role }, 'OTP sent to your email. Please verify to complete registration.')
      );
   }
);

/**
 * @desc    Verify OTP — creates the user in DB only on success
 * @route   POST /api/users/verify-otp
 * @access  Public
 */
const verifyOtp = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const { email, otp } = req.body;

      if (!email || !otp) {
         throw new ApiError(400, 'Email and OTP are required');
      }

      const pending = await PendingRegistration.findOne({ email });
      if (!pending) {
         throw new ApiError(400, 'No pending registration found. Please register first.');
      }

      if (pending.otp !== otp || pending.otpExpiry < new Date()) {
         throw new ApiError(400, 'Invalid or expired OTP');
      }

      // ✅ OTP valid — create verified user
      const user = await User.create({
         name: pending.name,
         email,
         password: pending.hashedPassword,
         isVerified: true,
         role: pending.role,
      });

      // Clean up pending registration
      await PendingRegistration.deleteOne({ email });

      const tokens = await generateAccessAndRefreshTokens(user._id.toString());

      return res.json(
         new ApiResponse(201, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            user: {
               _id: user._id,
               name: user.name,
               email: user.email,
               role: user.role,
               isVerified: user.isVerified,
            },
         }, 'Email verified successfully. Account created.')
      );
   }
);

/**
 * @desc    Login user
 * @route   POST /api/users/login
 * @access  Public
 */
const loginUser = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const { email, password } = req.body;

      if (!email || !password) {
         throw new ApiError(400, 'Email and password are required');
      }

      const user = await User.findOne({ email }).select('+password');
      if (!user) {
         throw new ApiError(404, 'User not found');
      }

      if (!user.isVerified) {
         throw new ApiError(403, 'Account not verified. Please complete OTP verification.');
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
         throw new ApiError(401, 'Invalid credentials');
      }

      const tokens = await generateAccessAndRefreshTokens(user._id.toString());

      return res.json(
         new ApiResponse(200, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            user: {
               _id: user._id,
               name: user.name,
               email: user.email,
               role: user.role,
               isVerified: user.isVerified,
            },
         }, 'Login successful.')
      );
   }
);

/**
 * @desc    Logout user
 * @route   POST /api/users/logout
 * @access  Private
 */
const logoutUser = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const authHeader = req.headers['authorization'];

      if (authHeader && authHeader.startsWith('Bearer ')) {
         const token = authHeader.split(' ')[1];
         const alreadyBlocked = await TokenBlocklist.findOne({ token });
         if (!alreadyBlocked) {
            await TokenBlocklist.create({ token });
         }
      }

      return res.json(new ApiResponse(200, { user: null }, 'Logout successful.'));
   }
);

/**
 * @desc    Get current logged-in user
 * @route   GET /api/users/me
 * @access  Private
 */
const getMe = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const user = req.user;
      if (!user) {
         throw new ApiError(401, 'Unauthorized: User not found');
      }

      const fullUser = await User.findById(user._id);
      if (!fullUser) {
         throw new ApiError(404, 'User not found');
      }

      return res.json(
         new ApiResponse(200, {
            _id: fullUser._id,
            name: fullUser.name,
            email: fullUser.email,
            role: fullUser.role,
            isVerified: fullUser.isVerified,
            stripeOnboardingComplete: fullUser.stripeOnboardingComplete,
         }, 'User fetched successfully')
      );
   }
);

/**
 * @desc    Login or register via Clerk (Google OAuth)
 * @route   POST /api/users/clerk-login
 * @access  Public
 */
const clerkLogin = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const clerkId = req.clerkId;
      const { role = 'user' } = req.body;

      if (!clerkId) {
         throw new ApiError(401, 'Unauthorized: No valid Clerk session found');
      }

      if (!['user', 'vendor'].includes(role)) {
         throw new ApiError(400, 'Invalid role. Must be user or vendor');
      }

      // Fetch user data from Clerk
      const clerkUser = await clerkClient.users.getUser(clerkId);

      const email = clerkUser.emailAddresses.find(
         (e) => e.id === clerkUser.primaryEmailAddressId
      )?.emailAddress;

      if (!email) {
         throw new ApiError(400, 'No email address found on this Clerk account');
      }

      const name =
         [clerkUser.firstName, clerkUser.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || email.split('@')[0];

      // Check if user exists by email or clerkId
      let user = await User.findOne({
         $or: [{ clerkId }, { email }]
      });

      if (user) {
         // Update existing user with clerkId if they don't have one
         if (!user.clerkId) {
            user.clerkId = clerkId;
            user.name = name;
            user.isVerified = true;
            user.role = role;
            await user.save();
         } else {
            // Update user info
            user.name = name;
            user.isVerified = true;
            user.role = role;
            await user.save();
         }
      } else {
         // Create new user
         user = await User.create({
            clerkId,
            name,
            email,
            password: crypto.randomBytes(16).toString('hex'),
            isVerified: true,
            role,
         });
      }

      const tokens = await generateAccessAndRefreshTokens(user._id.toString());

      return res.json(
         new ApiResponse(200, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            user: {
               _id: user._id,
               name: user.name,
               email: user.email,
               role: user.role,
               isVerified: user.isVerified,
            },
         }, 'Google login successful')
      );
   }
);

/**
 * @desc    Sync with existing Clerk session (for users already signed in)
 * @route   POST /api/users/clerk-sync
 * @access  Public (Clerk token required)
 */
const clerkSync = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const clerkId = req.clerkId;
      const { role = 'user' } = req.body;

      if (!clerkId) {
         throw new ApiError(401, 'Unauthorized: No valid Clerk session found');
      }

      if (!['user', 'vendor'].includes(role)) {
         throw new ApiError(400, 'Invalid role. Must be user or vendor');
      }

      // Fetch user data from Clerk
      try {
         const clerkUser = await clerkClient.users.getUser(clerkId);

         const email = clerkUser.emailAddresses.find(
            (e) => e.id === clerkUser.primaryEmailAddressId
         )?.emailAddress;

         if (!email) {
            throw new ApiError(400, 'No email address found on this Clerk account');
         }

         const name =
            [clerkUser.firstName, clerkUser.lastName]
               .filter(Boolean)
               .join(' ')
               .trim() || email.split('@')[0];

         // Check if user exists by email or clerkId
         let user = await User.findOne({
            $or: [{ clerkId }, { email }]
         });

         if (user) {
            // Update existing user info
            user.name = name;
            user.isVerified = true;
            if (role) user.role = role;
            if (!user.clerkId) user.clerkId = clerkId;
            await user.save();
         } else {
            // Create new user
            user = await User.create({
               clerkId,
               name,
               email,
               password: crypto.randomBytes(16).toString('hex'),
               isVerified: true,
               role,
            });
         }

         const tokens = await generateAccessAndRefreshTokens(user._id.toString());

         return res.json(
            new ApiResponse(200, {
               accessToken: tokens.accessToken,
               refreshToken: tokens.refreshToken,
               user: {
                  _id: user._id,
                  name: user.name,
                  email: user.email,
                  role: user.role,
                  isVerified: user.isVerified,
               },
            }, 'Clerk sync successful')
         );
      } catch (error: any) {
         // If Clerk user fetch fails, try to find existing user by clerkId
         const user = await User.findOne({ clerkId });
         if (user) {
            const tokens = await generateAccessAndRefreshTokens(user._id.toString());
            return res.json(
               new ApiResponse(200, {
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken,
                  user: {
                     _id: user._id,
                     name: user.name,
                     email: user.email,
                     role: user.role,
                     isVerified: user.isVerified,
                  },
               }, 'Clerk sync successful (cached)')
            );
         }
         throw new ApiError(401, 'Failed to sync with Clerk session');
      }
   }
);

/**
 * @desc    Update user details
 * @route   PUT /api/users/update
 * @access  Private
 */
const updateUserDetails = asyncHandler(
   async (req: Request, res: Response): Promise<any> => {
      const userId = req.user?._id;
      const { name, email } = req.body;

      if (!userId) {
         throw new ApiError(401, 'Unauthorized');
      }

      const user = await User.findById(userId);
      if (!user) {
         throw new ApiError(404, 'User not found');
      }

      if (name) user.name = name;
      if (email) user.email = email;

      await user.save();

      return res.json(
         new ApiResponse(200, {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
         }, 'User details updated successfully')
      );
   }
);

export {
   registerUser,
   verifyOtp,
   loginUser,
   logoutUser,
   getMe,
   clerkLogin,
   clerkSync,
   updateUserDetails,
};