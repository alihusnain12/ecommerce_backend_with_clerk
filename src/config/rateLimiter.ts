import rateLimit from 'express-rate-limit';

export const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // max 10 requests per IP in that window
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,     // sends RateLimit-* headers in response
  legacyHeaders: false,
});



// this code is for this if we want to apply rate limiting to specific routes


// const authLimiter = rateLimit({
//   windowMs: 10 * 60 * 1000, // 10 minutes
//   max: 5,                    // only 5 attempts per IP
//   message: { success: false, message: 'Too many login attempts. Try again in 10 minutes.' },
// });

// const otpLimiter = rateLimit({
//   windowMs: 10 * 60 * 1000,
//   max: 3,                    // only 3 OTP requests per IP
//   message: { success: false, message: 'Too many OTP requests. Try again later.' },
// });

// // Apply to specific routes
// router.post('/login', authLimiter, loginUser);
// router.post('/register', authLimiter, registerUser);
// router.post('/verify-otp', otpLimiter, verifyOtp);