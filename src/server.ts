import app from "./app";
import mongoose from "mongoose";
import dotenv from "dotenv";
import ConnectDB from "./config/db";

dotenv.config();

// Connect to MongoDB
ConnectDB();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
   console.log(`🚀 Server running on port ${PORT}`);
});