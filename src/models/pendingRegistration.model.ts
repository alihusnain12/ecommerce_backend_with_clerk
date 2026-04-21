// models/pendingRegistration.model.ts
import mongoose from 'mongoose';

interface IPendingRegistration extends mongoose.Document {
   name: string;
   email: string;
   hashedPassword: string;
   otp: string;
   otpExpiry: Date;
   role: string;
}

const pendingRegistrationSchema = new mongoose.Schema<IPendingRegistration>(
   {
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      hashedPassword: { type: String, required: true },
      otp: { type: String, required: true },
      otpExpiry: { type: Date, required: true },
      role: { type: String, required: true, enum: ['user', 'vendor'] },
   },
   { timestamps: true }
);

// Auto-delete document once otpExpiry timestamp is reached
pendingRegistrationSchema.index({ otpExpiry: 1 }, { expireAfterSeconds: 0 });

const PendingRegistration = mongoose.model<IPendingRegistration>(
   'PendingRegistration',
   pendingRegistrationSchema
);

export default PendingRegistration;