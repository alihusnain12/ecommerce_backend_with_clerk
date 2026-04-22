import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { limiter } from "./config/rateLimiter.ts";

const app = express();

// Routes
import UserRouter from "./routes/user.route.ts";
import ProductRouter from "./routes/product.route.ts";
import OrderRouter from "./routes/order.route.ts";
import VendorRouter from "./routes/vendor.route.ts";

// Stripe webhook routes - must be before express.json()
app.use("/api/orders/webhook", 
  express.raw({ type: 'application/json' }),
  (req, res, next) => { OrderRouter(req, res, next); }
);

app.use("/api/vendor/stripe/webhook", 
  express.raw({ type: 'application/json' }),
  (req, res, next) => { VendorRouter(req, res, next); }
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(limiter);

// Regular routes
app.use("/api/users", UserRouter);
app.use("/api/products", ProductRouter);
app.use("/api/orders", OrderRouter);
app.use("/api/vendor", VendorRouter);


export default app;