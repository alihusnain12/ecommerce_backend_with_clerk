# Use official Node.js image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your project
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Expose the port your app runs on
EXPOSE 8000

# Start the app
CMD ["node", "dist/server.js"]