import { Router } from 'express';
import {
   registerUser,
   verifyOtp,
   loginUser,
   logoutUser,
   getMe,
   clerkLogin,
   clerkSync,
   adminLogin,
   updateUserDetails,
} from '../controllers/user.controller.ts';
import authenticateUser from '../middlewares/auth.middleware.ts';
import verifyClerkToken from '../middlewares/clerk.middelware.ts';

const router = Router();

// Public Routes (No Authentication Required)

/**
 * @route   POST /api/users/register
 * @desc    Register a new user with email and password
 * @access  Public
 */
router.post('/register', registerUser);

/**
 * @route   POST /api/users/verify-otp
 * @desc    Verify OTP and generate access/refresh tokens
 * @access  Public
 */
router.post('/verify-otp', verifyOtp);

/**
 * @route   POST /api/users/login
 * @desc    Login user with email and password
 * @access  Public
 */
router.post('/login', loginUser);

/**
 * @route   POST /api/users/admin-login
 * @desc    Admin login using .env credentials
 * @access  Public
 */
router.post('/admin-login', adminLogin);

/**
 * @route   POST /api/users/clerk-login
 * @desc    Login user using Clerk authentication
 * @access  Public (Clerk token required)
 */
router.post('/clerk-login', verifyClerkToken, clerkLogin);

/**
 * @route   POST /api/users/clerk-sync
 * @desc    Sync with existing Clerk session (for users already signed in)
 * @access  Public (Clerk token required)
 */
router.post('/clerk-sync', verifyClerkToken, clerkSync);

// Protected Routes (Authentication Required)

/**
 * @route   GET /api/users/me
 * @desc    Get current logged-in user details
 * @access  Private (JWT token required)
 */
router.get('/me', authenticateUser, getMe);

/**
 * @route   POST /api/users/logout
 * @desc    Logout user and invalidate token
 * @access  Private (JWT token required)
 */
router.post('/logout', authenticateUser, logoutUser);

/**
 * @ Put /api/users/updateUser
 * @desc Update user details
 * @access Private (JWT token required)
 */
router.put('/updateUser', authenticateUser, updateUserDetails);
export default router;
