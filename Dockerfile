FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application code
COPY index.js ./

# Expose port (Railway will override with PORT env var)
EXPOSE 3000

# Run the application directly
CMD ["node", "index.js"]