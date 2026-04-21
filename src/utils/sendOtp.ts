import nodemailer from "nodemailer";

// Create transporter with better error handling
const createTransporter = () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error("Email credentials are not configured in environment variables");
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // This should be an App Password for Gmail
    },
    tls: {
      rejectUnauthorized: false, // Helps with some SSL issues
    },
  });
};

const sendOtpEmail = async (email: string, otp: string): Promise<void> => {
  try {
    const transporter = createTransporter();
    
    // Verify transporter configuration
    await transporter.verify();
    
    await transporter.sendMail({
      from: `"MyShop Auth" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your OTP Verification Code",
      html: `
        <div style="font-family:sans-serif;padding:24px;max-width:480px;background:#f8f9fa;border-radius:8px">
          <h2 style="color:#333">Verify Your Email</h2>
          <p style="color:#666">Your OTP code is:</p>
          <h1 style="letter-spacing:8px;color:#6c47ff;background:#fff;padding:16px;border-radius:4px;text-align:center">${otp}</h1>
          <p style="color:#666">This code expires in <strong>10 minutes</strong>.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#999;font-size:12px">If you didn't request this code, please ignore this email.</p>
        </div>
      `,
    });
  } catch (error) {
    console.error("Email sending failed:", error);
    throw new Error("Failed to send OTP email. Please check email configuration.");
  }
};

export { sendOtpEmail };