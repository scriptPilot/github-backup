# Use a lightweight base image
FROM node:20.9.0-alpine

# Install Git
RUN apk add --no-cache git

# Define the work directory
WORKDIR /usr/src/app

# Copy the package definition
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy the source files
COPY . .

# Start the backup script
CMD ["node", "index.js"]