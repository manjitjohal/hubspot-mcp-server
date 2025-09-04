FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application code
COPY index.js ./

# Expose port (Railway assigns 8080)
EXPOSE 8080

# Run the application directly
CMD ["node", "index.js"]