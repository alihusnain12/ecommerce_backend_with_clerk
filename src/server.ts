import app from "./app.ts";
import mongoose from "mongoose";
import dotenv from "dotenv";
import ConnectDB from "./config/db.ts";

dotenv.config();

// Connect to MongoDB
ConnectDB();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
   console.log(`🚀 Server running on port ${PORT}`);
});