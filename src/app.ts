import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { limiter } from "./config/rateLimiter.ts";
import verifyClerkToken from "./middlewares/clerk.middelware.ts";

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(limiter);

// Routes
import UserRouter from "./routes/user.route.ts";
app.use("/api/users", UserRouter);

export default app;