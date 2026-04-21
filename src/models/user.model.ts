import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// ─────────────────────────────────────────────
// INTERFACES
// ─────────────────────────────────────────────

/**
 * IUser defines the shape of a user document in MongoDB.
 * We extend mongoose.Document so TypeScript knows this object
 * has _id, save(), etc. built in.
 *
 * This model covers THREE types of people in the app:
 *  - 'user'   → a buyer who shops and checks out
 *  - 'vendor' → a seller who lists products and receives payouts
 *  - 'admin'  → platform administrator (add as needed)
 */
interface IUser extends mongoose.Document {
  name: string;
  email: string;
  password: string;
  role: 'user' | 'vendor' | 'admin';

  otp?: string;
  otpExpiry?: Date;
  isVerified: boolean;

  refreshToken?: string;

  clerkId?: string;

  // ── Stripe Connect fields (vendor-only) ──────────────────────
  // When a vendor onboards via Stripe Connect Express, Stripe gives
  // them an account ID like "acct_1ABC...".  We store it here so we
  // can send transfers to them after a successful buyer payment.
  stripeAccountId?: string;

  // Stripe's onboarding flow is multi-step (bank details, identity, etc.)
  // We track completion so we can block payouts until it's done.
  stripeOnboardingComplete: boolean;
  // ─────────────────────────────────────────────────────────────

  // Instance methods defined below
  comparePassword(enteredPassword: string): Promise<boolean>;
  generateAccessToken(): string;
  generateRefreshToken(): string;
}

/**
 * IUserStatics lets TypeScript know about static methods
 * we attach to the model (not to individual documents).
 */
interface IUserStatics {
  hashPassword(password: string): Promise<string>;
}

// ─────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────

const userSchema = new mongoose.Schema<IUser, mongoose.Model<IUser> & IUserStatics>(
  {
    name: {
      type: String,
      required: [true, 'Please enter your name'],
      trim: true,
    },

    email: {
      type: String,
      required: [true, 'Please enter your email'],
      unique: true,      // enforces uniqueness at DB index level
      lowercase: true,   // always store as lowercase to avoid case duplicates
      trim: true,
    },

    password: {
      type: String,
      required: false,   // optional because Clerk users may not have a password
      minlength: [6, 'Password must be at least 6 characters'],
      select: false,     // CRITICAL: never returned in API responses unless explicitly asked
                         // e.g. User.findById(id).select('+password') to include it
    },

    role: {
      type: String,
      enum: ['user', 'vendor', 'admin'],
      default: 'user',
      // A user starts as 'user'. Your onboarding flow upgrades them to 'vendor'
      // after they complete Stripe Connect onboarding.
    },

    refreshToken: {
      type: String,
      select: false, // same reason as password — never leak this in responses
    },

    clerkId: {
      type: String,
      unique: true,
      sparse: true, // sparse = only index documents that HAVE this field (not null/undefined)
                    // without sparse, two users without clerkId would violate the unique constraint
    },

    otp: {
      type: String,
      select: false, // hide from standard queries — only fetch when verifying OTP
    },

    otpExpiry: {
      type: Date,
      select: false,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    // ── Stripe Connect ────────────────────────────────────────────
    stripeAccountId: {
      type: String,
      // e.g. "acct_1PZv8QRwT1234567"
      // Populated when vendor completes Stripe Connect Express onboarding.
      // Used as the `destination` when calling stripe.transfers.create()
    },

    stripeOnboardingComplete: {
      type: Boolean,
      default: false,
      // Set to true via Stripe's account.updated webhook when
      // charges_enabled and payouts_enabled are both true on the account.
    },
    // ─────────────────────────────────────────────────────────────
  },
  {
    timestamps: true, // adds createdAt and updatedAt automatically
  }
);

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

/**
 * Pre-save hook: hash password before storing.
 * Only runs when the password field was actually modified —
 * prevents re-hashing an already-hashed password on unrelated saves
 * (e.g. when you update stripeAccountId).
 */
userSchema.pre('save', async function (next: any) {
  // 'this' refers to the document being saved
  if (!this.isModified('password')) {
    if (typeof next === 'function') {
      return next();
    }
    return;
  }

  try {
    const salt = await bcrypt.genSalt(10); // 10 rounds is the standard balance of speed vs security
    this.password = await bcrypt.hash(this.password, salt);
    if (typeof next === 'function') {
      return next();
    }
  } catch (error) {
    if (typeof next === 'function') {
      return next(error);
    }
  }
});

// ─────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────

/**
 * comparePassword: used at login to verify the entered password
 * against the stored bcrypt hash without exposing the hash itself.
 */
userSchema.methods.comparePassword = async function (enteredPassword: string): Promise<boolean> {
 
  return bcrypt.compare(enteredPassword, this.password);
};

/**
 * generateAccessToken: short-lived JWT sent to the client.
 * We embed _id, email, and role so middleware can authorize
 * without an extra DB query on every request.
 */
userSchema.methods.generateAccessToken = function (): string {
  return jwt.sign(
    { _id: this._id, email: this.email, role: this.role },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '7d' } as any
  );
};

/**
 * generateRefreshToken: long-lived JWT used to issue new access tokens.
 * Only embeds _id — the least amount of info needed to identify the user.
 */
userSchema.methods.generateRefreshToken = function (): string {
  return jwt.sign(
    { _id: this._id },
    process.env.REFRESH_TOKEN_SECRET as string,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '30d' } as any
  );
};

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * hashPassword: utility static for one-off hashing outside of save hooks,
 * e.g. when an admin resets a user's password directly.
 */
userSchema.statics.hashPassword = async function (password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

// ─────────────────────────────────────────────
// MODEL EXPORT
// ─────────────────────────────────────────────

const User = mongoose.model<IUser, mongoose.Model<IUser> & IUserStatics>('User', userSchema);

export default User;