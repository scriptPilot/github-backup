# User lightwight base image
FROM node:20.9.0-alpine

# Install Git
RUN apk add --no-cache git

# Define work directory
WORKDIR /usr/src/app

# Copy package definition
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Start backup script
CMD ["node", "index.js"]